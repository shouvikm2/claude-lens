import type { SessionState } from './sessionTracker.js';
import type { ClensConfig } from '../config/schema.js';
import type { LocalStore } from '../storage/localStore.js';

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
  constructor(private store: LocalStore) {}

  evaluate(state: SessionState, config: ClensConfig): BudgetReport {
    const softT = config.alerts.soft_threshold;
    const totals = this.store.getBudgetTotals();

    // Use gross cost (input + output + cache creation) for budget tracking.
    // Net cost subtracts cache savings which can zero out the figure entirely
    // for Pro/Max subscription users with large context windows — making
    // budget alerts meaningless. Gross cost reflects actual API work done.
    const gross = state.cost.input + state.cost.output + state.cost.cacheCreation;

    const sessionBand = band(gross, config.budget.session, softT);
    const dailyBand   = band(totals.dailySpend  + gross, config.budget.daily,   softT);
    const weeklyBand  = band(totals.weeklySpend + gross, config.budget.weekly,  softT);
    const overall = worstStatus(sessionBand.status, dailyBand.status, weeklyBand.status);

    return {
      session: sessionBand,
      daily: dailyBand,
      weekly: weeklyBand,
      overall,
    };
  }

}
