import * as vscode from 'vscode';

/**
 * Show a toast notification about turn quota usage
 */
export function notifyTurnQuotaUsage(
  turnPct: number,
  turnTokens: number,
  sessionPct: number
): void {
  const message = `Response used ${turnPct.toFixed(1)}% of session quota (${turnTokens.toLocaleString()} tokens). Session now at ${Math.round(sessionPct * 100)}%`;

  vscode.window.showInformationMessage(message);
}
