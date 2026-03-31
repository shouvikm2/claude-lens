import * as vscode from 'vscode';
import * as https from 'https';
import { log, logError } from '../utils/logger.js';
import type { SessionTracker } from '../core/sessionTracker.js';
import type { JournalEntry } from './claudeCodeProvider.js';

const SECRET_KEY = 'claudeLens.anthropicApiKey';
const USAGE_HOST = 'api.anthropic.com';

// ─── Anthropic Usage API response shapes ─────────────────────────────────────
// GET https://api.anthropic.com/v1/usage
// Returns per-model, per-day usage for the account tied to the API key.
// Only available for API/Workspace billing accounts.
// Claude Pro / Max subscription usage is NOT exposed via this endpoint.

interface UsageDataPoint {
  model:                        string;
  input_tokens:                 number;
  output_tokens:                number;
  cache_creation_input_tokens:  number;
  cache_read_input_tokens:      number;
  timestamp:                    string;   // ISO-8601
}

interface UsageResponse {
  data: UsageDataPoint[];
}

export class AnthropicUsageProvider {
  private pollTimer: NodeJS.Timeout | undefined;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  // ── Key management (SecretStorage only — never plaintext) ─────────────────

  async storeApiKey(key: string): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, key);
    log('Anthropic API key stored in SecretStorage');
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    log('Anthropic API key cleared');
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.context.secrets.get(SECRET_KEY);
    return !!key;
  }

  private async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_KEY);
  }

  // ── Fetch + ingest ─────────────────────────────────────────────────────────

  /**
   * Fetches today's usage from the Anthropic Usage API and injects it into
   * the session tracker as synthetic JournalEntry objects.
   * Returns true if the fetch succeeded, false on auth error or unavailability.
   */
  async fetchAndIngest(tracker: SessionTracker): Promise<boolean> {
    const key = await this.getApiKey();
    if (!key) return false;

    let data: UsageDataPoint[];
    try {
      data = await this.fetchTodayUsage(key);
    } catch (err) {
      logError('Anthropic Usage API fetch failed', err);
      vscode.window.showWarningMessage(
        '⬡ Claude Lens: Could not reach Anthropic Usage API. ' +
        'Note: this endpoint is for API/Workspace billing accounts only — ' +
        'Pro/Max subscription usage is not available via API.'
      );
      return false;
    }

    if (data.length === 0) {
      log('Anthropic Usage API returned no data for today');
      return true; // auth worked, just no usage yet
    }

    // Inject usage as synthetic entries so the rest of the pipeline
    // (sessionTracker, budgetEngine, roiScorer) works unchanged.
    for (const point of data) {
      const entry: JournalEntry = {
        type: 'assistant',
        timestamp: point.timestamp,
        message: {
          model: point.model,
          usage: {
            input_tokens:                 point.input_tokens,
            output_tokens:                point.output_tokens,
            cache_creation_input_tokens:  point.cache_creation_input_tokens,
            cache_read_input_tokens:      point.cache_read_input_tokens,
          },
        },
      };
      tracker.ingestEntry(entry);
    }

    // Use the earliest data point's timestamp as the session start
    const earliest = data
      .map(d => new Date(d.timestamp))
      .filter(d => !isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];

    if (earliest) tracker.beginSession(earliest);

    log(`Anthropic Usage API: ingested ${data.length} usage record(s)`);
    return true;
  }

  /** Start polling the usage API periodically. */
  startPolling(tracker: SessionTracker, intervalMs: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.fetchAndIngest(tracker), intervalMs);
    log(`Anthropic Usage API polling every ${intervalMs / 1000}s`);
  }

  dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  private fetchTodayUsage(apiKey: string): Promise<UsageDataPoint[]> {
    // Fetch usage for today only — the endpoint supports ?start_date=&end_date=
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const queryString = `start_date=${today}&end_date=${today}`;

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: USAGE_HOST,
        path: `/v1/usage?${queryString}`,
        method: 'GET',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
      };

      const req = https.request(options, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body) as UsageResponse;
              resolve(parsed.data ?? []);
            } catch (e) {
              reject(new Error(`Failed to parse usage response: ${String(e)}`));
            }
          } else if (res.statusCode === 403 || res.statusCode === 401) {
            reject(new Error(
              `Auth error ${res.statusCode} — this endpoint requires an API/Workspace key. ` +
              `Claude Pro/Max subscription usage is not available via the Anthropic Usage API.`
            ));
          } else {
            reject(new Error(`Usage API returned HTTP ${res.statusCode ?? 'unknown'}: ${body.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(new Error('Usage API request timed out')); });
      req.end();
    });
  }
}
