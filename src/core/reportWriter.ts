import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SessionState } from './sessionTracker.js';
import type { BudgetReport } from './budgetEngine.js';
import type { RoiSummary } from './roiScorer.js';
import type { ClensConfig } from '../config/schema.js';
import { formatCost, formatCostPrecise, formatDuration, roundToQuarterHour } from '../utils/formatter.js';
import { log, logError } from '../utils/logger.js';

export interface ReportOptions {
  session: SessionState;
  roiSummary: RoiSummary;
  budgetReport: BudgetReport;
  config: ClensConfig;
  workspaceRoot: string;
}

/** Returns the file path written, or undefined on failure. */
export async function writeReport(opts: ReportOptions): Promise<string | undefined> {
  const { session, config, workspaceRoot } = opts;

  // Skip empty sessions (no turns, no cost)
  if (session.turnCount === 0 && session.cost.net === 0) {
    log('Skipping report — empty session');
    return undefined;
  }

  const outputDir = path.isAbsolute(config.reports.output_dir)
    ? config.reports.output_dir
    : path.join(workspaceRoot, config.reports.output_dir);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    logError(`Failed to create report directory: ${outputDir}`, err);
    return undefined;
  }

  const timestamp = formatTimestamp(session.startTime);
  const fileName  = `${timestamp}.md`;
  const filePath  = path.join(outputDir, fileName);

  const content = buildReport(opts);

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    log(`Report written: ${filePath}`);
  } catch (err) {
    logError(`Failed to write report: ${filePath}`, err);
    return undefined;
  }

  // Notify user with "Open Report" action
  void vscode.window
    .showInformationMessage(
      `⬡ Claude Lens: Session report saved.`,
      'Open Report',
      'Open Folder'
    )
    .then(choice => {
      if (choice === 'Open Report') {
        void vscode.window.showTextDocument(vscode.Uri.file(filePath));
      } else if (choice === 'Open Folder') {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
      }
    });

  return filePath;
}

/** Lists all existing reports in the output directory, newest first. */
export function listReports(config: ClensConfig, workspaceRoot: string): string[] {
  const outputDir = path.isAbsolute(config.reports.output_dir)
    ? config.reports.output_dir
    : path.join(workspaceRoot, config.reports.output_dir);

  try {
    if (!fs.existsSync(outputDir)) return [];
    return fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(outputDir, f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── Markdown assembly ────────────────────────────────────────────────────────

function buildReport(opts: ReportOptions): string {
  const { session, roiSummary, budgetReport, config } = opts;

  const startStr    = session.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endStr      = (session.endTime ?? new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const durationMs  = (session.endTime ?? new Date()).getTime() - session.startTime.getTime();
  const dateStr     = session.startTime.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const modelShort  = session.model.replace(/^claude-/, '');

  const roiFitLabel: Record<string, string> = {
    good:                 '✓ Good — model well-matched to tasks',
    minor_overkill:       '⚠ Minor overkill — occasional over-powered model use',
    significant_overkill: '✗ Significant overkill — consider switching to a lighter model',
  };

  const lines: string[] = [
    `# Claude Lens Session Report`,
    ``,
    `**Project:** ${config.project}`,
    `**Date:** ${dateStr}`,
    `**Session:** ${startStr} → ${endStr} (${formatDuration(durationMs)})`,
    `**Model:** ${modelShort}`,
    ``,
    `---`,
    ``,
    `## Cost Summary`,
    ``,
    `| Category | Tokens | Cost |`,
    `|---|---|---|`,
    `| Input | ${session.tokens.input.toLocaleString()} | ${formatCostPrecise(session.cost.input)} |`,
    `| Output | ${session.tokens.output.toLocaleString()} | ${formatCostPrecise(session.cost.output)} |`,
    `| Cache created | ${session.tokens.cacheCreation.toLocaleString()} | ${formatCostPrecise(session.cost.cacheCreation)} |`,
    `| Cache savings | ${session.tokens.cacheRead.toLocaleString()} | -${formatCostPrecise(session.cost.cacheSavings)} |`,
    `| **Net cost** | | **${formatCost(session.cost.net)}** |`,
    ``,
    `**Budget status:** ${Math.round(budgetReport.session.pct * 100)}% of ${formatCost(budgetReport.session.cap)} session cap`,
    `**Daily total:** ${formatCost(budgetReport.daily.spent)} of ${formatCost(budgetReport.daily.cap)} daily cap`,
    ``,
    `---`,
    ``,
    `## ROI Summary`,
    ``,
    `- Turns scored: ${roiSummary.turnsScored}`,
    `- Optimal turns: ${roiSummary.optimalTurns} (${Math.round((1 - roiSummary.overkillPct) * 100)}%)`,
    `- Overkill turns: ${roiSummary.overkillTurns} (${Math.round(roiSummary.overkillPct * 100)}%)`,
    `- Potential saving: ~${formatCostPrecise(roiSummary.totalProjectedSaving)} this session`,
    `- Overall fit: ${roiFitLabel[roiSummary.overallFit] ?? roiSummary.overallFit}`,
    ``,
    `---`,
    ``,
    `## Activity`,
    ``,
  ];

  if (session.filesChanged.length > 0) {
    lines.push(`**Files touched:**`);
    for (const f of session.filesChanged) lines.push(`- \`${f}\``);
    lines.push('');
  }

  if (session.recentPrompts.length > 0) {
    lines.push(`**Session prompts (truncated):**`);
    session.recentPrompts.slice(0, 3).forEach((p, i) => {
      lines.push(`${i + 1}. "${p.replace(/"/g, "'")}"`);
    });
    lines.push('');
  }

  lines.push(`---`);
  lines.push('');

  // Client billing section
  if (config.reports.client_billing_mode && config.reports.client_name) {
    const hours      = roundToQuarterHour(durationMs);
    const devCost    = hours * config.reports.billing_rate_usd;
    const aiCost     = session.cost.net;
    const totalCost  = devCost + aiCost;
    const durationLabel = `${Math.floor(durationMs / 3600000)}h ${Math.round((durationMs % 3600000) / 60000)}m`;

    lines.push(`## Billing Summary`);
    lines.push('');
    lines.push(`**Client:** ${config.reports.client_name}`);
    lines.push(`**Project:** ${config.project}`);
    lines.push(`**Date:** ${dateStr}`);
    lines.push('');
    lines.push(`| Item | Hours | Rate | Amount |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| Development (${durationLabel}) | ${hours.toFixed(2)} | $${config.reports.billing_rate_usd}/hr | ${formatCost(devCost)} |`);
    lines.push(`| AI tooling cost | — | at cost | ${formatCostPrecise(aiCost)} |`);
    lines.push(`| **Total** | | | **${formatCost(totalCost)}** |`);
    lines.push('');
    lines.push(`*AI cost reflects actual Claude API usage tracked by Claude Lens.*`);
    lines.push(`*Development time rounded to nearest 15 minutes.*`);
    lines.push('');
    lines.push(`---`);
    lines.push('');
  }

  lines.push(`*Generated by Claude Lens v0.1.0 — all data local, zero telemetry*`);
  lines.push('');

  return lines.join('\n');
}

function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}
