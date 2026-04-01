import * as vscode from 'vscode';
import type { SessionState } from '../core/sessionTracker.js';
import type { BudgetReport } from '../core/budgetEngine.js';
import type { PlanLimits } from '../providers/claudeAiLimitsProvider.js';
import { formatCost, formatDuration } from '../utils/formatter.js';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private refreshTimer: NodeJS.Timeout | undefined;

  private lastSession: SessionState | undefined;
  private lastBudget:  BudgetReport  | undefined;
  private lastLimits:  PlanLimits | null | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      'claudeLens.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'claudeLens.openHUD';
    this.item.name    = 'Claude Lens';
    this.item.text    = '⬡ Claude Lens';
    this.item.show();

    // Refresh every 30 s so the reset-timer ticks down
    this.refreshTimer = setInterval(() => this.renderWithLastState(), 30_000);
  }

  update(session: SessionState, budget: BudgetReport): void {
    this.lastSession = session;
    this.lastBudget  = budget;
    this.render();
  }

  updateLimits(limits: PlanLimits | null): void {
    this.lastLimits = limits;
    this.render();
  }

  private renderWithLastState(): void { this.render(); }

  private render(): void {
    const session = this.lastSession;
    const budget  = this.lastBudget;
    if (!session || !budget) return;

    const modelShort = session.model.replace('claude-', '').replace(/-\d{8}$/, '');
    const lim        = this.lastLimits;

    // ── Quota segment ─────────────────────────────────────────────────────
    // Show real plan quota (session %) when available; fall back to API cost.
    let quotaText: string;
    let bgColor: vscode.ThemeColor | undefined;

    if (lim?.session) {
      const sessionPct = Math.round(lim.session.pctUsed * 100);
      const weeklyPct = lim.weekly ? Math.round(lim.weekly.pctUsed * 100) : undefined;
      const resetsIn = formatDuration(Math.max(0, lim.session.resetAt.getTime() - Date.now()));

      quotaText = weeklyPct !== undefined
        ? `${sessionPct}%/${weeklyPct}% ⏱${resetsIn}`
        : `${sessionPct}% ⏱${resetsIn}`;

      // Use higher of session or weekly for alert color
      const maxPct = Math.max(sessionPct, weeklyPct ?? 0);
      if (maxPct >= 90)      bgColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      else if (maxPct >= 80) bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      else                bgColor = undefined;
    } else {
      // No plan quota yet — fall back to API cost estimate
      const spent = formatCost(budget.session.spent);
      const cap   = formatCost(budget.session.cap);
      quotaText   = budget.overall === 'over' ? `OVER ${cap}` : `${spent}/${cap}`;

      const statusColors: Record<string, vscode.ThemeColor | undefined> = {
        ok:        undefined,
        soft_warn: new vscode.ThemeColor('statusBarItem.warningBackground'),
        hard_warn: new vscode.ThemeColor('statusBarItem.errorBackground'),
        over:      new vscode.ThemeColor('statusBarItem.errorBackground'),
      };
      bgColor = statusColors[budget.overall];
    }

    this.item.text            = `⬡ ${quotaText}  ${modelShort}`;
    this.item.backgroundColor = bgColor;
    this.item.tooltip         = this.buildTooltip(session, budget);
  }

  private buildTooltip(session: SessionState, budget: BudgetReport): string {
    const gross = session.cost.input + session.cost.output + session.cost.cacheCreation;
    const lim   = this.lastLimits;

    const lines: string[] = ['Claude Lens', ''];

    // Plan quota block
    if (lim?.session || lim?.weekly) {
      lines.push('── Plan Quota ──────────────────');
      if (lim?.session) {
        const pct      = Math.round(lim.session.pctUsed * 100);
        const resetsIn = formatDuration(Math.max(0, lim.session.resetAt.getTime() - Date.now()));
        lines.push(`Session:        ${pct}%  (resets in ${resetsIn})`);
      }
      if (lim?.weekly) {
        const pct     = Math.round(lim.weekly.pctUsed * 100);
        const resetAt = lim.weekly.resetAt.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`Weekly:         ${pct}%  (resets ${resetAt})`);
      }
      lines.push('');
    }

    // Token / cost block
    lines.push(
      '── API Cost Estimate ───────────',
      `Tokens in:      ${session.tokens.input.toLocaleString()}`,
      `Tokens out:     ${session.tokens.output.toLocaleString()}`,
      `Cache created:  ${session.tokens.cacheCreation.toLocaleString()}`,
      `Cache read:     ${session.tokens.cacheRead.toLocaleString()}`,
      ``,
      `Gross cost:     ${formatCost(gross)}`,
      `Cache savings:  -${formatCost(session.cost.cacheSavings)}`,
      `Net API cost:   ${formatCost(session.cost.net)}`,
      ``,
      `Session cap:    ${formatCost(budget.session.cap)} (${Math.round(budget.session.pct * 100)}% used)`,
      `Weekly cap:     ${formatCost(budget.weekly.cap)} (${Math.round(budget.weekly.pct * 100)}% used)`,
    );

    return lines.join('\n');
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.item.dispose();
  }
}
