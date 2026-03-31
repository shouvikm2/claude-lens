import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { calculateCost } from '../utils/priceTable.js';
import { log } from '../utils/logger.js';
import type { JournalEntry } from '../providers/claudeCodeProvider.js';

const SESSION_WINDOW_HOURS = 5;

export interface SessionState {
  id: string;
  startTime: Date;
  endTime?: Date;
  model: string;
  tokens: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheSavings: number;
    net: number;
  };
  turnCount: number;
  resetTime: Date;
  recentPrompts: string[];
  filesChanged: string[];
}

function emptySession(startTime: Date): SessionState {
  return {
    id: randomUUID(),
    startTime,
    model: 'unknown',
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    cost: { input: 0, output: 0, cacheCreation: 0, cacheSavings: 0, net: 0 },
    turnCount: 0,
    // Reset time is 5 hours from when the Claude Code session actually started,
    // not from when this extension activated.
    resetTime: new Date(startTime.getTime() + SESSION_WINDOW_HOURS * 60 * 60 * 1000),
    recentPrompts: [],
    filesChanged: [],
  };
}

export class SessionTracker {
  private state: SessionState = emptySession(new Date());
  private readonly updateEmitter = new vscode.EventEmitter<SessionState>();
  private readonly resetEmitter  = new vscode.EventEmitter<SessionState>();
  private resetTimer: NodeJS.Timeout | undefined;

  readonly onUpdate = this.updateEmitter.event;
  readonly onReset  = this.resetEmitter.event;

  /**
   * Called by the provider when it loads a JSONL file and knows the real
   * session start time from the first entry's timestamp.
   * This replaces the guessed "extension activation" start time.
   */
  beginSession(startTime: Date): void {
    // If this session start is the same window (within 5h) as the current
    // state's start, just correct the timestamps — don't clear accumulated data.
    const sameWindow =
      Math.abs(startTime.getTime() - this.state.startTime.getTime()) <
      SESSION_WINDOW_HOURS * 60 * 60 * 1000;

    if (sameWindow && this.state.turnCount > 0) {
      // Correct the start/reset times without wiping the already-ingested data
      this.state.startTime = startTime;
      this.state.resetTime = new Date(startTime.getTime() + SESSION_WINDOW_HOURS * 60 * 60 * 1000);
      log(`Session start corrected from JSONL: ${startTime.toISOString()}`);
    } else {
      // Different session window entirely — start fresh
      this.state = emptySession(startTime);
      log(`New session begun from JSONL: ${startTime.toISOString()}`);
    }

    this.scheduleReset();
    this.updateEmitter.fire(this.state);
  }

  ingestEntry(entry: JournalEntry): void {
    if (entry.type === 'user') {
      const text = this.extractText(entry);
      if (text) {
        this.state.recentPrompts = [...this.state.recentPrompts, text.slice(0, 100)].slice(-10);
      }
      return;
    }

    if (entry.type !== 'assistant') return;
    const { usage, model } = entry.message;
    if (!usage) return;

    if (model) this.state.model = model;

    this.state.tokens.input         += usage.input_tokens                  ?? 0;
    this.state.tokens.output        += usage.output_tokens                 ?? 0;
    this.state.tokens.cacheCreation += usage.cache_creation_input_tokens   ?? 0;
    this.state.tokens.cacheRead     += usage.cache_read_input_tokens       ?? 0;
    this.state.tokens.total =
      this.state.tokens.input + this.state.tokens.output +
      this.state.tokens.cacheCreation + this.state.tokens.cacheRead;

    this.state.turnCount += 1;
    this.state.cost = calculateCost(
      { input: this.state.tokens.input, output: this.state.tokens.output,
        cacheCreation: this.state.tokens.cacheCreation, cacheRead: this.state.tokens.cacheRead },
      this.state.model
    );

    this.updateEmitter.fire(this.state);
  }

  recordFileChanged(relativePath: string): void {
    if (!this.state.filesChanged.includes(relativePath)) {
      this.state.filesChanged = [...this.state.filesChanged, relativePath].slice(-50);
    }
  }

  getState(): SessionState {
    return {
      ...this.state,
      recentPrompts: [...this.state.recentPrompts],
      filesChanged:  [...this.state.filesChanged],
    };
  }

  /** Manual reset (user command or new JSONL file detected by provider). */
  reset(): void {
    log(`Session reset — was: ${this.state.id}`);
    const completed: SessionState = { ...this.getState(), endTime: new Date() };
    this.resetEmitter.fire(completed);
    this.state = emptySession(new Date());
    this.scheduleReset();
    this.updateEmitter.fire(this.state);
  }

  dispose(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.updateEmitter.dispose();
    this.resetEmitter.dispose();
  }

  private scheduleReset(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    const msUntilReset = this.state.resetTime.getTime() - Date.now();
    // Only schedule if the window hasn't already expired
    if (msUntilReset > 0) {
      this.resetTimer = setTimeout(() => this.reset(), msUntilReset);
    }
  }

  private extractText(entry: JournalEntry): string {
    const content = (entry.message as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null &&
          (b as Record<string, unknown>)['type'] === 'text'
        )
        .map(b => b.text)
        .join(' ');
    }
    return '';
  }
}
