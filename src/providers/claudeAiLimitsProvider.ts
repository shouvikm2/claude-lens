import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { log } from '../utils/logger.js';
import { sanitizeSensitiveData } from '../utils/sanitize.js';

export interface SessionLimit {
  pctUsed:  number;   // 0–1
  resetAt:  Date;
}

export interface PlanLimits {
  session:          SessionLimit | undefined;
  weekly:           SessionLimit | undefined;
  subscriptionType: string;
}

interface CredentialFile {
  claudeAiOauth: {
    accessToken:      string;
    refreshToken?:    string;
    expiresAt?:       string;
    subscriptionType?: string;
  };
  organizationUuid?: string;
}

export class ClaudeAiLimitsProvider {
  private creds:     CredentialFile | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastData:  PlanLimits | undefined;
  private lastError: string | undefined;
  private lastCredsFetch = 0;
  private readonly CREDS_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

  // ── Load credentials from ~/.claude/.credentials.json ────────────────────

  async load(): Promise<boolean> {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      await fs.promises.access(credPath, fs.constants.R_OK);
    } catch {
      log('ClaudeAiLimitsProvider: .credentials.json not found');
      this.lastError = 'credentials file not found (~/.claude/.credentials.json)';
      return false;
    }

    // Check file permissions (warn if overly permissive)
    await this.checkCredentialsFilePermissions(credPath);

    try {
      const raw = await fs.promises.readFile(credPath, 'utf-8');
      this.creds = JSON.parse(raw) as CredentialFile;
      this.lastCredsFetch = Date.now();
      const ok = !!this.creds.claudeAiOauth?.accessToken;
      log(`ClaudeAiLimitsProvider: credentials loaded — ok=${ok}`);
      if (!ok) this.lastError = 'No OAuth access token in credentials file';
      return ok;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = `Failed to read credentials: ${msg}`;
      log(`ClaudeAiLimitsProvider: failed to read credentials — ${msg}`);
      return false;
    }
  }

  private async checkCredentialsFilePermissions(credPath: string): Promise<void> {
    try {
      const stat = await fs.promises.stat(credPath);
      // On Unix/Linux: file mode should be 0o600 (user read/write only)
      // File permissions: mode & 0o777 extracts the permission bits
      // We check if group/other have any permissions: (mode & 0o077) should be 0
      const mode = stat.mode & 0o777;
      const hasGroupOrOtherPerms = (mode & 0o077) !== 0;

      if (hasGroupOrOtherPerms) {
        log(`[WARNING] Credentials file has overly permissive permissions (${mode.toString(8)}). ` +
            `Recommended: chmod 600 ~/.claude/.credentials.json`);
      }
    } catch {
      // Silently ignore on Windows or if stat fails (can't check permissions reliably)
    }
  }

  // ── Fetch limits ──────────────────────────────────────────────────────────

  async fetchLimits(): Promise<PlanLimits | undefined> {
    // Only re-read credentials from disk if cache expired.
    // Claude Code updates token ~hourly, so 5-min cache is safe while
    // significantly reducing plaintext filesystem accesses.
    const now = Date.now();
    if (now - this.lastCredsFetch > this.CREDS_CACHE_TTL_MS) {
      await this.load();
    }
    if (!this.creds?.claudeAiOauth?.accessToken) return undefined;

    const token   = this.creds.claudeAiOauth.accessToken;
    const subType = this.creds.claudeAiOauth.subscriptionType ?? 'unknown';

    // Undocumented but community-confirmed endpoint (GitHub issue #13585).
    // Returns the exact session/weekly usage shown on claude.ai/settings.
    // Requires the Claude Code OAuth token (not an API key) + beta header.
    // Known to rate-limit aggressively — we poll at most every 5 minutes.
    const urlPath = '/api/oauth/usage';
    try {
      log(`ClaudeAiLimitsProvider: GET https://api.anthropic.com${urlPath}`);
      const body = await this.get(urlPath, token);
      log(`ClaudeAiLimitsProvider: response: ${JSON.stringify(sanitizeSensitiveData(body))}`);
      const parsed = this.parseLimits(body, subType);
      if (parsed) {
        this.lastData = parsed;
        this.lastError = undefined;
        return parsed;
      }
      this.lastError = 'Unexpected response shape from claude.ai';
      log('ClaudeAiLimitsProvider: response shape not recognised');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      log(`ClaudeAiLimitsProvider: request failed — ${msg}`);
    }
    return undefined;
  }

  getLastData(): PlanLimits | undefined { return this.lastData; }
  getLastError(): string | undefined { return this.lastError; }

  // Called externally when a turn completes so quota updates immediately
  // rather than waiting for the next poll. Respects a minimum gap to avoid
  // hammering the endpoint when turns arrive back-to-back.
  private lastRefreshAt = 0;
  private onChange: ((limits: PlanLimits | null) => void) | undefined;

  async refreshNow(): Promise<void> {
    const MIN_GAP_MS = 15_000;  // never call more than once per 15s
    if (Date.now() - this.lastRefreshAt < MIN_GAP_MS) return;
    this.lastRefreshAt = Date.now();
    const data = await this.fetchLimits();
    this.onChange?.(data ?? null);
  }

  // Returns subscriptionType from credentials without making an API call.
  // Used to set initial tree item states before the first poll completes.
  getSubscriptionType(): string | undefined {
    return this.creds?.claudeAiOauth?.subscriptionType;
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  startPolling(onChange: (limits: PlanLimits | null) => void, intervalMs = 300_000): void {
    this.onChange = onChange;
    let failCount = 0;

    const schedule = (delayMs: number) => {
      this.pollTimer = setTimeout(() => void tick(), delayMs);
    };

    const tick = async () => {
      this.lastRefreshAt = Date.now();
      const data = await this.fetchLimits();
      if (data) {
        failCount = 0;
        onChange(data);
        schedule(intervalMs);
      } else {
        failCount++;
        onChange(null);
        // On failure, retry at 30s up to 3 times before settling into normal cadence
        schedule(failCount <= 3 ? 30_000 : intervalMs);
      }
    };

    // Schedule the first tick immediately (setImmediate equivalent) so pollTimer is set synchronously
    schedule(0);
  }

  // ── Response parser ───────────────────────────────────────────────────────
  // The exact shape isn't documented — we handle several plausible formats
  // and log the raw body above so we can update this once we see real data.

  private parseLimits(body: unknown, subType: string): PlanLimits | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const b = body as Record<string, unknown>;

    // Confirmed response shape from api.anthropic.com/api/oauth/usage:
    // { five_hour: { utilization: 54.0, resets_at: "..." },
    //   seven_day: { utilization: 53.0, resets_at: "..." },
    //   seven_day_sonnet: { ... } | null,
    //   seven_day_opus: { ... } | null }
    if (b['five_hour'] !== undefined || b['seven_day'] !== undefined) {
      return {
        subscriptionType: subType,
        session: this.parseUtilObj(b['five_hour']),
        weekly:  this.parseUtilObj(b['seven_day']),
      };
    }

    return undefined;
  }

  private parseUtilObj(obj: unknown): SessionLimit | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const r = obj as Record<string, unknown>;
    const util = r['utilization'];
    const resetRaw = r['resets_at'];

    // Coerce utilization to number (handle string or null cases)
    const utilNum = typeof util === 'number' ? util : typeof util === 'string' ? Number(util) : null;
    if (utilNum === null || isNaN(utilNum)) {
      log(`ClaudeAiLimitsProvider: invalid utilization value: ${String(util)} (type: ${typeof util})`);
      return undefined;
    }

    if (typeof resetRaw !== 'string' && typeof resetRaw !== 'number') {
      log(`ClaudeAiLimitsProvider: invalid resets_at value: ${String(resetRaw)} (type: ${typeof resetRaw})`);
      return undefined;
    }

    const resetAt = new Date(resetRaw);
    if (isNaN(resetAt.getTime())) {
      log(`ClaudeAiLimitsProvider: could not parse resets_at as date: ${String(resetRaw)}`);
      return undefined;
    }

    return { pctUsed: utilNum / 100, resetAt };   // utilization is 0-100
  }

  // ── HTTP helper ───────────────────────────────────────────────────────────

  private get(urlPath: string, token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };

      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          path:     urlPath,
          method:   'GET',
          headers:  {
            'Authorization':  `Bearer ${token}`,
            'Content-Type':   'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent':     'claude-lens-vscode/0.1.0',
          },
        },
        res => {
          if (settled) return;

          let raw = '';
          res.on('data', (chunk: Buffer) => {
            if (!settled) raw += chunk.toString();
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            cleanup();

            if (!res.statusCode || res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode ?? '?'}: ${raw.slice(0, 200)}`));
              return;
            }
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error(`non-JSON response: ${raw.slice(0, 200)}`)); }
          });
        }
      );

      req.on('error', err => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });

      // Increased timeout from 10s to 30s. The endpoint is rate-limited,
      // and aggressive timeouts cause retries that trigger the rate limit.
      // 30s provides a reasonable grace period for legitimate requests.
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          req.destroy(new Error('HTTP request timeout (30s)'));
        }
      }, 30_000);

      req.on('close', () => {
        cleanup();
      });

      req.end();
    });
  }

  dispose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }
}
