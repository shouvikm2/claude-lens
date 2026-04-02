import * as vscode from 'vscode';
import type { SessionState } from '../core/sessionTracker.js';
import type { BudgetReport } from '../core/budgetEngine.js';
import type { ClensConfig } from '../config/schema.js';
import type { RoiSummary } from '../core/roiScorer.js';
import type { DataSource } from '../extension.js';
import type { PlanLimits } from '../providers/claudeAiLimitsProvider.js';
import { getActiveModel } from '../core/modelSwitcher.js';
import { formatCost, formatDuration, formatProgressBar } from '../utils/formatter.js';

// ─── Generic tree item ───────────────────────────────────────────────────────

class LensItem extends vscode.TreeItem {
  children: LensItem[] = [];
  constructor(label: string, collapsible = vscode.TreeItemCollapsibleState.None) {
    super(label, collapsible);
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<LensItem> {
  private readonly changeEmitter = new vscode.EventEmitter<LensItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private session:    SessionState | undefined;
  private budget:     BudgetReport | undefined;
  private config:     ClensConfig  | undefined;
  private roi:        RoiSummary   | undefined;
  private planLimits: PlanLimits | null | undefined;  // undefined=loading, null=failed, PlanLimits=ok
  private planError: string | undefined;
  private planStalenessMs: number | undefined;  // how old the plan data is (ms)

  private configFileExists = false;
  private dataSource: DataSource = 'none';

  // Debounce tree refreshes — multiple rapid state changes collapse into one render
  private refreshTimer: NodeJS.Timeout | undefined;
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;  // already scheduled
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changeEmitter.fire(undefined);
    }, 100);
  }

  update(session: SessionState, budget: BudgetReport, config: ClensConfig, roi: RoiSummary, dataSource: DataSource): void {
    this.session    = session;
    this.budget     = budget;
    this.config     = config;
    this.roi        = roi;
    this.dataSource = dataSource;
    this.scheduleRefresh();
  }

  refresh(): void { this.scheduleRefresh(); }

  updatePlanLimits(limits: PlanLimits | null, error?: string, stalenessMs?: number): void {
    this.planLimits = limits;
    this.planError = error;
    this.planStalenessMs = stalenessMs;
    this.scheduleRefresh();
  }

  setConfigFileExists(exists: boolean): void {
    this.configFileExists = exists;
    this.scheduleRefresh();
  }

  getTreeItem(element: LensItem): vscode.TreeItem { return element; }

  getChildren(element?: LensItem): vscode.ProviderResult<LensItem[]> {
    if (!element) return this.buildRoots();
    return element.children;
  }

  // ── Root sections ──────────────────────────────────────────────────────────

  private buildRoots(): LensItem[] {
    const roots: LensItem[] = [];
    roots.push(this.buildPlanQuotaSection());
    if (this.budget && this.config && this.session && this.roi) {
      roots.push(this.buildBudgetSection(this.session, this.budget, this.config));
      // Model ROI: show for all users now that they can switch models via the Config section.
      roots.push(this.buildRoiSection(this.session, this.roi));
      roots.push(this.buildSessionSection(this.session));
    }
    roots.push(this.buildConfigSection());
    return roots;
  }

  // ── Plan Quota ─────────────────────────────────────────────────────────────

  private formatStaleness(ms: number): string {
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
  }

  private buildPlanQuotaSection(): LensItem {
    const lim = this.planLimits;
    const isStale = this.planStalenessMs && this.planStalenessMs > 10 * 60_000;  // older than 10 minutes

    const root = new LensItem(
      lim ? `🌐 Plan Quota (${lim.subscriptionType})${isStale ? ' — data may be stale' : ''}` : '🌐 Plan Quota (claude.ai)',
      vscode.TreeItemCollapsibleState.Expanded
    );

    const link = this.iconLeaf('View on claude.ai', 'link-external');
    link.command = { command: 'claudeLens.openClaudeAiUsage', title: 'Open claude.ai Usage', arguments: [] };

    if (lim && (lim.session || lim.weekly)) {
      const children: LensItem[] = [];

      if (lim.session) {
        const pct    = Math.round(lim.session.pctUsed * 100);
        const bar    = formatProgressBar(lim.session.pctUsed, 10);
        const resetsIn = formatDuration(Math.max(0, lim.session.resetAt.getTime() - Date.now()));
        const staleInfo = this.planStalenessMs ? `  (updated ${this.formatStaleness(this.planStalenessMs)})` : '';
        const item   = this.leaf(`Session   ${pct}%  [${bar}]  resets in ${resetsIn}${staleInfo}`);
        if (pct >= 90) item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('statusBarItem.errorBackground'));
        else if (pct >= 80) item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('statusBarItem.warningBackground'));
        children.push(item);
      }

      if (lim.weekly) {
        const pct    = Math.round(lim.weekly.pctUsed * 100);
        const bar    = formatProgressBar(lim.weekly.pctUsed, 10);
        const resetsAt = lim.weekly.resetAt.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        const item   = this.leaf(`Weekly    ${pct}%  [${bar}]  resets ${resetsAt}`);
        if (pct >= 90) item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('statusBarItem.errorBackground'));
        else if (pct >= 80) item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('statusBarItem.warningBackground'));
        children.push(item);
      }

      // Last turn quota consumption
      if (this.session?.lastTurnQuotaUsage) {
        const turn = this.session.lastTurnQuotaUsage;
        const bar  = formatProgressBar(turn.pct / 100, 10);
        const item = this.leaf(`Last turn  ${turn.pct.toFixed(1)}%  [${bar}]  ${turn.tokens.toLocaleString()} tokens`);
        // Color code: green if < 10%, amber if 10-25%, red if > 25%
        if (turn.pct > 25) item.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('statusBarItem.errorBackground'));
        else if (turn.pct >= 10) item.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('statusBarItem.warningBackground'));
        else item.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('statusBarItem.prominentBackground'));
        children.push(item);
      }

      children.push(link);
      root.children = children;
    } else {
      if (lim === undefined) {
        root.children = [this.leaf('Fetching usage from claude.ai…'), link];
      } else {
        // null: no data available. Only show error if we don't have cached data.
        // This case should rarely happen now with graceful degradation.
        const detail = this.planError
          ? this.leaf(`Could not load — ${this.planError}`)
          : this.leaf('Could not load — check Output > Claude Lens');
        root.children = [detail, link];
      }
    }

    return root;
  }

  // ── Budget ─────────────────────────────────────────────────────────────────

  private isProMax(): boolean {
    const sub = this.planLimits?.subscriptionType?.toLowerCase() ?? '';
    return sub === 'pro' || sub === 'max' || sub.startsWith('claude_');
  }

  private buildBudgetSection(
    _session: SessionState, budget: BudgetReport, config: ClensConfig
  ): LensItem {
    // Collapse by default for Pro/Max — dollar caps are less relevant when
    // the real quota is shown in the Plan Quota section above.
    const collapsed = this.isProMax()
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;

    const root = new LensItem(`💰 API Cost Estimate — ${config.project}`, collapsed);

    const statusLabel: Record<string, string> = {
      ok:        '✓ comfortable',
      soft_warn: '⚠ approaching limit',
      hard_warn: '⚠ near limit',
      over:      '✗ over limit',
    };

    const children: LensItem[] = [];

    // Only show the disclaimer when we don't have real plan limits
    if (!this.planLimits) {
      children.push(this.leaf('⚠ Using public API pricing — Pro/Max usage % differs'));
    }

    children.push(
      this.makeBand('Session', budget.session.spent, budget.session.cap, budget.session.pct),
      this.makeBand('Daily',   budget.daily.spent,   budget.daily.cap,   budget.daily.pct),
      this.makeBand('Weekly',  budget.weekly.spent,  budget.weekly.cap,  budget.weekly.pct),
      this.leaf(`Status:   ${statusLabel[budget.overall] ?? budget.overall}`)
    );

    root.children = children;
    return root;
  }

  private makeBand(label: string, spent: number, cap: number, pct: number): LensItem {
    const bar = formatProgressBar(pct, 10);
    return this.leaf(
      `${label.padEnd(8)} ${formatCost(spent)} / ${formatCost(cap)}  [${bar}] ${Math.round(pct * 100)}%`
    );
  }

  // ── ROI ────────────────────────────────────────────────────────────────────

  private buildRoiSection(session: SessionState, roi: RoiSummary): LensItem {
    const root = new LensItem('🎯 Model ROI', vscode.TreeItemCollapsibleState.Collapsed);

    const fitLabel: Record<string, string> = {
      good:                 '✓ good fit',
      minor_overkill:       '⚠ minor overkill',
      significant_overkill: '✗ significant overkill',
    };

    const modelShort = session.model.replace(/^claude-/, '');

    if (roi.turnsScored === 0) {
      root.children = [this.leaf('No turns scored yet this session')];
      return root;
    }

    root.children = [
      this.leaf(`Active model:      ${modelShort}  ${fitLabel[roi.overallFit] ?? ''}`),
      this.leaf(`This session:      ${roi.turnsScored} turns — ${roi.optimalTurns} optimal, ${roi.overkillTurns} overkill`),
      this.leaf(`Overkill cost est: ~${formatCost(roi.totalProjectedSaving)} this session`),
    ];
    return root;
  }

  // ── Session Detail ─────────────────────────────────────────────────────────

  private buildSessionSection(session: SessionState): LensItem {
    const root = new LensItem('📊 Session Detail', vscode.TreeItemCollapsibleState.Collapsed);

    const gross = session.cost.input + session.cost.output + session.cost.cacheCreation;
    root.children = [
      this.leaf(`Tokens in:       ${session.tokens.input.toLocaleString()}`),
      this.leaf(`Tokens out:      ${session.tokens.output.toLocaleString()}`),
      this.leaf(`Cache created:   ${session.tokens.cacheCreation.toLocaleString()}`),
      this.leaf(`Cache read:      ${session.tokens.cacheRead.toLocaleString()}`),
      this.leaf(`API cost est.:   ${formatCost(gross)}  (gross, excl. cache savings)`),
      this.leaf(`Cache savings:   -${formatCost(session.cost.cacheSavings)}`),
      this.leaf(`Net API cost:    ${formatCost(session.cost.net)}`),
    ];
    return root;
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  private buildConfigSection(): LensItem {
    const root = new LensItem('⚙ Config', vscode.TreeItemCollapsibleState.Collapsed);

    const sourceLabels: Record<DataSource, string> = {
      'claude-code-logs': '✓ Claude Code logs (local, exact)',
      'anthropic-api':    '✓ Anthropic Usage API',
      'none':             '✗ No data source — Claude Code not detected',
    };

    const sourceItem = this.leaf(`Data source:  ${sourceLabels[this.dataSource]}`);
    const clensItem  = this.leaf(`.claudelens:  ${this.configFileExists ? '✓ found' : '✗ missing'}`);
    const edit = this.iconLeaf('Edit .claudelens', 'edit');
    edit.command = { command: 'claudeLens.openConfig', title: 'Edit .claudelens', arguments: [] };

    // Model switcher — shows active model from ~/.claude/settings.json
    const activeModel = getActiveModel();
    const modelLabel  = activeModel
      ? activeModel.replace('claude-', '').replace(/-\d{8}$/, '')
      : 'default (sonnet)';
    const switchModel = this.iconLeaf(`Model: ${modelLabel}  — click to switch`, 'symbol-misc');
    switchModel.command = { command: 'claudeLens.switchModel', title: 'Switch Claude Code Model', arguments: [] };

    root.children = [sourceItem, clensItem, switchModel, edit];

    if (!this.configFileExists) {
      const create = this.iconLeaf('Create .claudelens', 'add');
      create.command = { command: 'claudeLens.createConfig', title: 'Create .claudelens', arguments: [] };
      root.children.push(create);
    }

    if (this.dataSource !== 'claude-code-logs') {
      const setKey = this.iconLeaf('Set Anthropic API Key', 'key');
      setKey.command = { command: 'claudeLens.setApiKey', title: 'Set Anthropic API Key', arguments: [] };
      root.children.push(setKey);
    }

    if (this.dataSource === 'anthropic-api') {
      const clearKey = this.iconLeaf('Clear API Key', 'trash');
      clearKey.command = { command: 'claudeLens.clearApiKey', title: 'Clear API Key', arguments: [] };
      root.children.push(clearKey);
    }

    return root;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private leaf(label: string): LensItem {
    return new LensItem(label, vscode.TreeItemCollapsibleState.None);
  }

  private iconLeaf(label: string, icon: string): LensItem {
    const item = new LensItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.changeEmitter.dispose();
  }
}
