import type { JournalEntry } from '../providers/claudeCodeProvider.js';
import { log, logError } from '../utils/logger.js';

// Tokenizer priority:
// 1. @anthropic-ai/tokenizer — Anthropic's own Claude BPE vocabulary (closest to Claude)
// 2. js-tiktoken (cl100k_base) — OpenAI's tokenizer (~1-5% variance from Claude)
// 3. text.length / 4 — rough estimation fallback

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let anthropicCountTokens: ((text: string) => number) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tiktokenEncoding: any;
let activeTokenizer: 'anthropic' | 'tiktoken' | 'estimate' = 'estimate';

async function loadTokenizers(): Promise<void> {
  if (activeTokenizer !== 'estimate') return; // Already loaded

  // Try Anthropic's tokenizer first (Claude's own BPE vocabulary)
  try {
    const mod = await import('@anthropic-ai/tokenizer');
    anthropicCountTokens = mod.countTokens;
    activeTokenizer = 'anthropic';
    log('Token verification using @anthropic-ai/tokenizer (Claude BPE vocabulary)');
    return;
  } catch {
    // Not available — try fallback
  }

  // Fallback: js-tiktoken with cl100k_base
  try {
    const mod = await import('js-tiktoken');
    tiktokenEncoding = mod.getEncoding('cl100k_base');
    activeTokenizer = 'tiktoken';
    log('Token verification using js-tiktoken cl100k_base (fallback, ~1-5% variance)');
    return;
  } catch {
    // Not available either
  }

  logError('No tokenizer available — token verification will use chars/4 estimation');
}

export interface TokenAuditRecord {
  entryTimestamp: string;      // When this turn happened
  reportedCounts: {
    input: number;
    output: number;
  };
  calculatedCounts: {
    input: number;
    output: number;
  };
  discrepancies: {
    inputDelta: number;        // |reported - calculated|
    outputDelta: number;       // |reported - calculated|
    inputPctDelta: number;     // (inputDelta / reported) * 100
    outputPctDelta: number;    // (outputDelta / reported) * 100
    hasIssue: boolean;         // true if any delta > threshold (5%)
  };
  model: string;
  notes?: string;
}

export interface TokenVerificationSummary {
  totalEntriesVerified: number;
  entriesWithDiscrepancies: number;
  maxInputDeltaPct: number;
  maxOutputDeltaPct: number;
  overallStatus: 'healthy' | 'minor_variance' | 'significant_variance';
  lastVerified?: Date;
  allRecords: TokenAuditRecord[];
}

const DISCREPANCY_THRESHOLD_PCT = 5; // Flag if variance > ±5%

/**
 * TokenVerifier independently estimates token counts from raw text using js-tiktoken
 * and compares them against reported counts from Claude Code's JSONL logs.
 *
 * This is a non-blocking, informational verification layer:
 * - Does NOT override reported counts (those remain authoritative)
 * - Does NOT affect cost calculations or ROI scoring
 * - Does emit audit records that can be displayed in the UI
 */
export class TokenVerifier {
  private auditRecords: TokenAuditRecord[] = [];

  /**
   * Attempt to load tokenizers in priority order:
   * 1. @anthropic-ai/tokenizer (Claude's own BPE)
   * 2. js-tiktoken cl100k_base (OpenAI, ~1-5% variance)
   * 3. text.length / 4 estimation
   */
  async loadTokenizer(): Promise<void> {
    await loadTokenizers();
  }

  /**
   * Verify a single journal entry by tokenizing its content and comparing
   * against the reported usage counts.
   *
   * Returns null if:
   * - Entry lacks content or usage data
   * - Tokenizer fails (graceful degradation)
   * - Entry type is not 'assistant' (no output to verify)
   */
  verifyEntry(entry: JournalEntry): TokenAuditRecord | null {
    try {
      // Only verify assistant responses with usage data
      if (entry.type !== 'assistant' || !entry.message.usage) {
        return null;
      }

      // Extract raw text content
      const responseText = this.extractText(entry.message.content);
      if (!responseText) {
        return null;
      }

      const model = entry.message.model ?? 'unknown';
      const reported = {
        input: entry.message.usage.input_tokens ?? 0,
        output: entry.message.usage.output_tokens ?? 0,
      };

      // Tokenize response to estimate output tokens
      const calculatedOutput = this.countTokens(responseText);

      // For input tokens, we can't easily reverse-engineer from a single entry
      // (input includes system prompt, context history, etc.). Skip input comparison
      // and only compare output (which is self-contained in the response).
      // Future: could cross-reference with previous entries to estimate input.

      const outputDelta = Math.abs(reported.output - calculatedOutput);
      const outputPctDelta = reported.output > 0 ? (outputDelta / reported.output) * 100 : 0;

      const record: TokenAuditRecord = {
        entryTimestamp: entry.timestamp,
        reportedCounts: reported,
        calculatedCounts: {
          input: reported.input, // Can't calculate, use reported as placeholder
          output: calculatedOutput,
        },
        discrepancies: {
          inputDelta: 0,        // Not verified
          outputDelta,
          inputPctDelta: 0,     // Not verified
          outputPctDelta,
          hasIssue: outputPctDelta > DISCREPANCY_THRESHOLD_PCT,
        },
        model,
      };

      // Log if discrepancy is found
      if (record.discrepancies.hasIssue) {
        log(
          `Token audit: output variance detected at ${entry.timestamp}: ` +
          `reported ${reported.output} vs. calculated ${calculatedOutput} (±${outputPctDelta.toFixed(1)}%)`
        );
      }

      this.auditRecords.push(record);
      return record;
    } catch (err) {
      logError(`TokenVerifier.verifyEntry() failed: ${err}`);
      return null; // Graceful degradation
    }
  }

  /**
   * Get aggregated summary statistics for the session.
   */
  getSummary(): TokenVerificationSummary {
    const entriesWithIssues = this.auditRecords.filter(r => r.discrepancies.hasIssue);
    const outputDeltas = this.auditRecords.map(r => r.discrepancies.outputPctDelta);
    const maxOutputDeltaPct = outputDeltas.length > 0 ? Math.max(...outputDeltas) : 0;

    let overallStatus: TokenVerificationSummary['overallStatus'] = 'healthy';
    if (entriesWithIssues.length > 0) {
      const issueRate = entriesWithIssues.length / this.auditRecords.length;
      overallStatus = issueRate >= 0.5 ? 'significant_variance' : 'minor_variance';
    }

    return {
      totalEntriesVerified: this.auditRecords.length,
      entriesWithDiscrepancies: entriesWithIssues.length,
      maxInputDeltaPct: 0, // Input not verified
      maxOutputDeltaPct: maxOutputDeltaPct,
      overallStatus,
      lastVerified: this.auditRecords.length > 0
        ? new Date(this.auditRecords[this.auditRecords.length - 1].entryTimestamp)
        : undefined,
      allRecords: [...this.auditRecords],
    };
  }

  /**
   * Reset audit history (typically called on session reset/switch).
   */
  reset(): void {
    this.auditRecords = [];
  }

  /**
   * Extract text content from a JournalEntry's message content.
   * Handles various content formats (string, object, unknown).
   */
  private extractText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (typeof content === 'object' && content !== null) {
      // Handle markdown-like { type: 'text', text: '...' } format
      const obj = content as Record<string, unknown>;
      if (typeof obj.text === 'string') {
        return obj.text;
      }
      if (typeof obj.content === 'string') {
        return obj.content;
      }
      // Fallback: stringify (may be verbose but captures essence)
      try {
        return JSON.stringify(content);
      } catch {
        return '';
      }
    }

    return '';
  }

  /**
   * Count tokens using the best available tokenizer:
   * 1. @anthropic-ai/tokenizer — Claude's own BPE vocabulary
   * 2. js-tiktoken cl100k_base — OpenAI (~1-5% variance from Claude)
   * 3. text.length / 4 — rough fallback
   */
  private countTokens(text: string): number {
    try {
      if (activeTokenizer === 'anthropic' && anthropicCountTokens) {
        return anthropicCountTokens(text);
      }
      if (activeTokenizer === 'tiktoken' && tiktokenEncoding) {
        return tiktokenEncoding.encode(text).length;
      }
    } catch (err) {
      logError(`Tokenization failed: ${err}`);
    }

    // Last resort: rough estimation (1 token ≈ 4 characters)
    return Math.ceil(text.length / 4);
  }

  /** Returns which tokenizer is active for diagnostics */
  getActiveTokenizer(): string {
    return activeTokenizer;
  }
}
