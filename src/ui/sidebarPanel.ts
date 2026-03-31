import * as vscode from 'vscode';
import * as path from 'path';
import type { SessionState } from '../core/sessionTracker.js';
import type { BudgetReport } from '../core/budgetEngine.js';
import type { ClensConfig } from '../config/schema.js';
import type { RoiSummary } from '../core/roiScorer.js';
import type { DataSource } from '../extension.js';
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
  private reports:    string[]     = [];
  private configFileExists = false;
  private dataSource: DataSource = 'none';

  update(session: SessionState, budget: BudgetReport, config: ClensConfig, roi: RoiSummary, dataSource: DataSource): void {
    this.session    = session;
    this.budget     = budget;
    this.config     = config;
    this.roi        = roi;
    this.dataSource = dataSource;
    this.changeEmitter.fire(undefined);
  }

  setReports(paths: string[]): void {
    this.reports = paths;
    this.changeEmitter.fire(undefined);
  }

  setConfigFileExists(exists: boolean): void {
    this.configFileExists = exists;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: LensItem): vscode.TreeItem { return element; }

  getChildren(element?: LensItem): vscode.ProviderResult<LensItem[]> {
    if (!element) return this.buildRoots();
    return element.children;
  }

  // ── Root sections ──────────────────────────────────────────────────────────

  private buildRoots(): LensItem[] {
    const roots: LensItem[] = [];
    if (this.budget && this.config && this.session && this.roi) {
      roots.push(this.buildBudgetSection(this.session, this.budget, this.config));
      roots.push(this.buildRoiSection(this.session, this.roi));
      roots.push(this.buildSessionSection(this.session));
    }
    roots.push(this.buildReportsSection());
    roots.push(this.buildConfigSection());
    return roots;
  }

  // ── Budget ─────────────────────────────────────────────────────────────────

  private buildBudgetSection(
    session: SessionState, budget: BudgetReport, config: ClensConfig
  ): LensItem {
    const root = new LensItem(
      `💰 Budget — ${config.project}`,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const statusLabel: Record<string, string> = {
      ok:        '✓ comfortable',
      soft_warn: '⚠ approaching limit',
      hard_warn: '⚠ near limit',
      over:      '✗ over limit',
    };

    root.children = [
      this.makeBand('Session', session.cost.net,   budget.session.cap, budget.session.pct),
      this.makeBand('Daily',   budget.daily.spent,  budget.daily.cap,   budget.daily.pct),
      this.makeBand('Weekly',  budget.weekly.spent, budget.weekly.cap,  budget.weekly.pct),
      this.leaf(`Status:   ${statusLabel[budget.overall] ?? budget.overall}`),
    ];
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

    root.children = [
      this.leaf(`Active model:      ${modelShort}  ${fitLabel[roi.overallFit] ?? ''}`),
      this.leaf(`This session:      ${roi.turnsScored} turns — ${roi.optimalTurns} optimal, ${roi.overkillTurns} overkill`),
      this.leaf(`Overkill cost:     ~${formatCost(roi.totalProjectedSaving)} this session`),
    ];
    return root;
  }

  // ── Session Detail ─────────────────────────────────────────────────────────

  private buildSessionSection(session: SessionState): LensItem {
    const root = new LensItem('📊 Session Detail', vscode.TreeItemCollapsibleState.Collapsed);
    const started  = session.startTime.toLocaleTimeString();
    const resetsAt = session.resetTime.toLocaleTimeString();
    const remaining = formatDuration(Math.max(0, session.resetTime.getTime() - Date.now()));

    root.children = [
      this.leaf(`Tokens in:       ${session.tokens.input.toLocaleString()}`),
      this.leaf(`Tokens out:      ${session.tokens.output.toLocaleString()}`),
      this.leaf(`Cache created:   ${session.tokens.cacheCreation.toLocaleString()}`),
      this.leaf(`Cache read:      ${session.tokens.cacheRead.toLocaleString()}`),
      this.leaf(`Cache savings:   ${formatCost(session.cost.cacheSavings)}`),
      this.leaf(`Net cost:        ${formatCost(session.cost.net)}`),
      this.leaf(`Session started: ${started}  (resets in ${remaining} at ${resetsAt})`),
    ];
    return root;
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  private buildReportsSection(): LensItem {
    const root = new LensItem('📋 Reports', vscode.TreeItemCollapsibleState.Collapsed);
    const children: LensItem[] = [];

    if (this.reports.length > 0) {
      const lastReport = path.basename(this.reports[0], '.md');
      children.push(this.leaf(`Last report:  ${this.formatReportName(lastReport)}`));

      // Count reports from this week
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const thisWeek = this.reports.filter(r => {
        const ts = this.parseReportTimestamp(path.basename(r, '.md'));
        return ts && ts.getTime() > weekAgo;
      }).length;
      children.push(this.leaf(`This week:    ${thisWeek} report${thisWeek !== 1 ? 's' : ''} generated`));
    } else {
      children.push(this.leaf('No reports yet'));
    }

    const generate = this.leaf('$(play) Generate Now');
    generate.command = { command: 'claudeLens.generateReport', title: 'Generate Report Now', arguments: [] };
    children.push(generate);

    const openFolder = this.leaf('$(folder-opened) Open Reports Folder');
    openFolder.command = { command: 'claudeLens.openReportsFolder', title: 'Open Reports Folder', arguments: [] };
    children.push(openFolder);

    root.children = children;
    return root;
  }

  private formatReportName(name: string): string {
    // "20260330-114200" → "2026-03-30 11:42"
    const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!m) return name;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  }

  private parseReportTimestamp(name: string): Date | undefined {
    const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!m) return undefined;
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  private buildConfigSection(): LensItem {
    const root = new LensItem('⚙ Config', vscode.TreeItemCollapsibleState.Collapsed);

    const sourceLabels: Record<DataSource, string> = {
      'claude-code-logs': '✓ Claude Code logs (local, exact)',
      'anthropic-api':    '✓ Anthropic Usage API',
      'manual':           '⚠ Manual entry',
      'none':             '✗ No data source — Claude Code not detected',
    };

    const sourceItem = this.leaf(`Data source:  ${sourceLabels[this.dataSource]}`);
    const clensItem  = this.leaf(`.claudelens:  ${this.configFileExists ? '✓ found' : '✗ missing'}`);
    const edit       = this.leaf('$(edit) Edit .claudelens');
    edit.command = { command: 'claudeLens.openConfig', title: 'Edit .claudelens', arguments: [] };

    root.children = [sourceItem, clensItem, edit];

    if (!this.configFileExists) {
      const create = this.leaf('$(add) Create .claudelens');
      create.command = { command: 'claudeLens.createConfig', title: 'Create .claudelens', arguments: [] };
      root.children.push(create);
    }

    // Show API key management when not using Claude Code logs
    if (this.dataSource !== 'claude-code-logs') {
      const setKey = this.leaf('$(key) Set Anthropic API Key');
      setKey.command = { command: 'claudeLens.setApiKey', title: 'Set Anthropic API Key', arguments: [] };
      root.children.push(setKey);
    }

    if (this.dataSource === 'anthropic-api') {
      const clearKey = this.leaf('$(trash) Clear API Key');
      clearKey.command = { command: 'claudeLens.clearApiKey', title: 'Clear API Key', arguments: [] };
      root.children.push(clearKey);
    }

    return root;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private leaf(label: string): LensItem {
    return new LensItem(label, vscode.TreeItemCollapsibleState.None);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
