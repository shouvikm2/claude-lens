import * as vscode from 'vscode';
import type { SessionTracker } from '../core/sessionTracker.js';
import type { JournalEntry } from './claudeCodeProvider.js';

/**
 * Fallback provider for users who are not using Claude Code.
 * Presents a quick-pick input allowing manual token entry.
 */
export class ManualProvider {
  constructor(private tracker: SessionTracker) {}

  async promptManualEntry(): Promise<void> {
    const modelItems = [
      { label: 'claude-sonnet-4-6', description: 'Sonnet (recommended)' },
      { label: 'claude-opus-4-6', description: 'Opus' },
      { label: 'claude-haiku-4-5-20251001', description: 'Haiku' },
    ];

    const modelPick = await vscode.window.showQuickPick(modelItems, {
      title: 'Claude Lens — Manual Entry',
      placeHolder: 'Select the model used',
    });
    if (!modelPick) return;

    const inputTokensStr = await vscode.window.showInputBox({
      title: 'Input tokens',
      prompt: 'How many input tokens were used?',
      validateInput: v => (isNaN(Number(v)) ? 'Enter a number' : undefined),
    });
    if (!inputTokensStr) return;

    const outputTokensStr = await vscode.window.showInputBox({
      title: 'Output tokens',
      prompt: 'How many output tokens were used?',
      validateInput: v => (isNaN(Number(v)) ? 'Enter a number' : undefined),
    });
    if (!outputTokensStr) return;

    const entry: JournalEntry = {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        model: modelPick.label,
        usage: {
          input_tokens: parseInt(inputTokensStr, 10),
          output_tokens: parseInt(outputTokensStr, 10),
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };

    this.tracker.ingestEntry(entry);
    vscode.window.showInformationMessage('⬡ Claude Lens: Manual entry recorded.');
  }
}
