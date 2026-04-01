import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { log } from '../utils/logger.js';

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

  // ── Load credentials from ~/.claude/.credentials.json ────────────────────

  async load(): Promise<boolean> {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) {
      log('ClaudeAiLimitsProvider: .credentials.json not found');
      return false;
    }
    try {
      const raw = fs.readFileSync(credPath, 'utf-8');
      this.creds = JSON.parse(raw) as CredentialFile;
      const ok = !!this.creds.claudeAiOauth?.accessToken;
      log(`ClaudeAiLimitsProvider: credentials loaded — ok=${ok}`);
      return ok;
    } catch (e) {
      log(`ClaudeAiLimitsProvider: failed to read credentials — ${e}`);
      return false;
    }
  }

  // ── Fetch limits ──────────────────────────────────────────────────────────

  async fetchLimits(): Promise<PlanLimits | undefined> {
    // Re-read credentials fresh every fetch — Claude Code auto-refreshes
    // the OAuth token and overwrites .credentials.json, so the in-memory
    // copy becomes stale within ~1 hour.
    await this.load();
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
      log(`ClaudeAiLimitsProvider: response: ${JSON.stringify(body)}`);
      const parsed = this.parseLimits(body, subType);
      if (parsed) {
        this.lastData = parsed;
        return parsed;
      }
      log('ClaudeAiLimitsProvider: response shape not recognised');
    } catch (e) {
      log(`ClaudeAiLimitsProvider: request failed — ${e}`);
    }
    return undefined;
  }

  getLastData(): PlanLimits | undefined { return this.lastData; }

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

    const tick = async () => {
      this.lastRefreshAt = Date.now();
      const data = await this.fetchLimits();
      if (data) {
        failCount = 0;
        onChange(data);
      } else {
        failCount++;
        onChange(null);
        // On failure, retry at 30s up to 3 times before settling into normal cadence
        if (failCount <= 3) {
          setTimeout(() => void tick(), 30_000);
        }
      }
    };

    void tick();
    this.pollTimer = setInterval(() => void tick(), intervalMs);
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
          let raw = '';
          res.on('data', (chunk: Buffer) => raw += chunk.toString());
          res.on('end', () => {
            if (!res.statusCode || res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode ?? '?'}: ${raw.slice(0, 200)}`));
              return;
            }
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error(`non-JSON response: ${raw.slice(0, 200)}`)); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
