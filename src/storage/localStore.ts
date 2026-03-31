import * as vscode from 'vscode';

const STATE_KEY = 'claudeLens.state';

export interface SessionRecord {
  id: string;
  startTime: string;
  endTime: string;
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
}

export interface BudgetTotals {
  dailySpend: number;
  weeklySpend: number;
  dailyResetAt: string;
  weeklyResetAt: string;
}

export interface RoiRecord {
  sessionId: string;
  timestamp: string;
  complexityScore: number;
  activeModel: string;
  recommendedModel: string;
  isOverkill: boolean;
  projectedSaving: number;
}

export interface StoredState {
  sessions: SessionRecord[];
  budgetTotals: BudgetTotals;
  roiHistory: RoiRecord[];
  lastUpdated: string;
}

const DEFAULT_BUDGET_TOTALS: BudgetTotals = {
  dailySpend: 0,
  weeklySpend: 0,
  dailyResetAt: new Date().toISOString(),
  weeklyResetAt: new Date().toISOString(),
};

export class LocalStore {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  getState(): StoredState {
    return this.context.globalState.get<StoredState>(STATE_KEY, {
      sessions: [],
      budgetTotals: DEFAULT_BUDGET_TOTALS,
      roiHistory: [],
      lastUpdated: new Date().toISOString(),
    });
  }

  async updateState(update: Partial<StoredState>): Promise<void> {
    const current = this.getState();
    await this.context.globalState.update(STATE_KEY, {
      ...current,
      ...update,
      lastUpdated: new Date().toISOString(),
    });
  }

  async appendSession(record: SessionRecord): Promise<void> {
    const state = this.getState();
    // Keep last 90 sessions to avoid unbounded growth
    const sessions = [...state.sessions, record].slice(-90);
    await this.updateState({ sessions });
  }

  async appendRoiRecord(record: RoiRecord): Promise<void> {
    const state = this.getState();
    const roiHistory = [...state.roiHistory, record].slice(-500);
    await this.updateState({ roiHistory });
  }

  async updateBudgetTotals(totals: BudgetTotals): Promise<void> {
    await this.updateState({ budgetTotals: totals });
  }

  getBudgetTotals(): BudgetTotals {
    return this.getState().budgetTotals;
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, undefined);
  }
}
