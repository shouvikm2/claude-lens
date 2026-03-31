import * as vscode from 'vscode';
import type { SessionState } from './sessionTracker.js';
import type { ClensConfig } from '../config/schema.js';
import type { LocalStore } from '../storage/localStore.js';
import { formatCost } from '../utils/formatter.js';
import { log } from '../utils/logger.js';

export type BudgetStatus = 'ok' | 'soft_warn' | 'hard_warn' | 'over';

export interface BudgetBand {
  spent: number;
  cap: number;
  pct: number;
  status: BudgetStatus;
}

export interface BudgetReport {
  session: BudgetBand;
  daily: BudgetBand;
  weekly: BudgetBand;
  overall: BudgetStatus;
}

function band(spent: number, cap: number, softThreshold: number): BudgetBand {
  const pct = cap > 0 ? spent / cap : 0;
  let status: BudgetStatus = 'ok';
  if (pct >= 1) status = 'over';
  else if (pct >= 1 - (1 - softThreshold) * 0.5) status = 'hard_warn';
  else if (pct >= softThreshold) status = 'soft_warn';
  return { spent, cap, pct, status };
}

function worstStatus(...statuses: BudgetStatus[]): BudgetStatus {
  const order: BudgetStatus[] = ['ok', 'soft_warn', 'hard_warn', 'over'];
  return statuses.reduce((worst, s) =>
    order.indexOf(s) > order.indexOf(worst) ? s : worst
  , 'ok');
}

export class BudgetEngine {
  private prevReport: BudgetReport | undefined;
  private lastSoftAlert = 0;
  private lastHardAlert = 0;

  constructor(private store: LocalStore) {}

  evaluate(state: SessionState, config: ClensConfig): BudgetReport {
    const softT = config.alerts.soft_threshold;
    const totals = this.store.getBudgetTotals();

    const sessionBand = band(state.cost.net, config.budget.session, softT);
    const dailyBand = band(totals.dailySpend + state.cost.net, config.budget.daily, softT);
    const weeklyBand = band(totals.weeklySpend + state.cost.net, config.budget.weekly, softT);
    const overall = worstStatus(sessionBand.status, dailyBand.status, weeklyBand.status);

    return {
      session: sessionBand,
      daily: dailyBand,
      weekly: weeklyBand,
      overall,
    };
  }

  alert(report: BudgetReport, config: ClensConfig): void {
    const prev = this.prevReport;
    this.prevReport = report;

    if (!prev) return;
    const now = Date.now();

    // Soft alert fires once per transition into soft_warn
    if (
      report.overall === 'soft_warn' &&
      prev.overall === 'ok' &&
      now - this.lastSoftAlert > 60_000
    ) {
      this.lastSoftAlert = now;
      log(`Soft budget alert fired — ${formatCost(report.session.spent)}/${formatCost(report.session.cap)}`);
      vscode.window
        .showWarningMessage(
          `⬡ Budget Alert: Session spend at ${Math.round(report.session.pct * 100)}% of ${formatCost(report.session.cap)} cap`,
          'View Details',
          'Dismiss'
        )
        .then(choice => {
          if (choice === 'View Details') {
            vscode.commands.executeCommand('claudeLens.openHUD');
          }
        });
    }

    // Hard alert fires once per transition into hard_warn or over
    if (
      (report.overall === 'hard_warn' || report.overall === 'over') &&
      prev.overall !== 'hard_warn' &&
      prev.overall !== 'over' &&
      now - this.lastHardAlert > 60_000
    ) {
      this.lastHardAlert = now;
      const label =
        report.overall === 'over'
          ? `⬡ Budget Limit: Session cap of ${formatCost(report.session.cap)} reached`
          : `⬡ Budget Warning: Session at ${Math.round(report.session.pct * 100)}% of ${formatCost(report.session.cap)} cap`;

      const actions = config.alerts.hard_stop
        ? (['Continue Anyway', 'Stop'] as const)
        : (['Continue Anyway', 'Dismiss'] as const);

      log(`Hard budget alert fired — ${label}`);
      vscode.window.showWarningMessage(label, ...actions);
    }
  }
}
