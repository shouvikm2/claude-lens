import * as vscode from 'vscode';
import type { SessionState } from '../core/sessionTracker.js';
import type { BudgetReport } from '../core/budgetEngine.js';
import { formatCost, formatDuration } from '../utils/formatter.js';

type BudgetStatus = 'ok' | 'soft_warn' | 'hard_warn' | 'over';

const STATUS_COLORS: Record<BudgetStatus, vscode.ThemeColor | undefined> = {
  ok: undefined,
  soft_warn: new vscode.ThemeColor('statusBarItem.warningBackground'),
  hard_warn: new vscode.ThemeColor('statusBarItem.errorBackground'),
  over: new vscode.ThemeColor('statusBarItem.errorBackground'),
};

const ROI_ICONS: Record<BudgetStatus, string> = {
  ok: '✓',
  soft_warn: '⚠',
  hard_warn: '⚠',
  over: '✗',
};

export class StatusBar {
  private item: vscode.StatusBarItem;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      'claudeLens.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'claudeLens.openHUD';
    this.item.name = 'Claude Lens';
    this.item.text = '⬡ Claude Lens';
    this.item.show();

    // Refresh every 30 seconds for the timer countdown
    this.refreshTimer = setInterval(() => this.renderWithLastState(), 30_000);
  }

  private lastSession: SessionState | undefined;
  private lastBudget: BudgetReport | undefined;

  update(session: SessionState, budget: BudgetReport): void {
    this.lastSession = session;
    this.lastBudget = budget;
    this.render(session, budget);
  }

  private renderWithLastState(): void {
    if (this.lastSession && this.lastBudget) {
      this.render(this.lastSession, this.lastBudget);
    }
  }

  private render(session: SessionState, budget: BudgetReport): void {
    const status = budget.overall;
    const spent = formatCost(session.cost.net);
    const cap = formatCost(budget.session.cap);
    const roi = ROI_ICONS[status];
    const modelShort = session.model.replace('claude-', '').replace(/-\d{8}$/, '');
    const remaining = session.resetTime.getTime() - Date.now();
    const timer = formatDuration(Math.max(0, remaining));

    if (status === 'over') {
      this.item.text = `⬡ OVER ${cap}  ROI:${roi}  ${modelShort}  ⏱${timer}`;
    } else {
      this.item.text = `⬡ ${spent}/${cap}  ROI:${roi}  ${modelShort}  ⏱${timer}`;
    }

    this.item.backgroundColor = STATUS_COLORS[status];
    this.item.tooltip = this.buildTooltip(session, budget);
  }

  private buildTooltip(session: SessionState, budget: BudgetReport): string {
    const lines = [
      `Claude Lens — Session Cost`,
      ``,
      `Tokens in:     ${session.tokens.input.toLocaleString()}`,
      `Tokens out:    ${session.tokens.output.toLocaleString()}`,
      `Cache created: ${session.tokens.cacheCreation.toLocaleString()}`,
      `Cache read:    ${session.tokens.cacheRead.toLocaleString()}`,
      ``,
      `Net cost:      ${formatCost(session.cost.net)}`,
      `Session cap:   ${formatCost(budget.session.cap)} (${Math.round(budget.session.pct * 100)}%)`,
      `Daily cap:     ${formatCost(budget.daily.cap)} (${Math.round(budget.daily.pct * 100)}%)`,
      `Weekly cap:    ${formatCost(budget.weekly.cap)} (${Math.round(budget.weekly.pct * 100)}%)`,
      ``,
      `Resets in:     ${formatDuration(Math.max(0, session.resetTime.getTime() - Date.now()))}`,
    ];
    return lines.join('\n');
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.item.dispose();
  }
}
