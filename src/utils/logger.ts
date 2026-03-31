import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Claude Lens');
  }
  return channel;
}

export function log(message: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getLogger().appendLine(`[${new Date().toISOString()}] ERROR: ${message}${errMsg ? ` — ${errMsg}` : ''}`);
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
