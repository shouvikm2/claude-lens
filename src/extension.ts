import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceConfig } from './config/workspaceConfig.js';
import { LocalStore } from './storage/localStore.js';
import { ClaudeCodeProvider } from './providers/claudeCodeProvider.js';
import { AnthropicUsageProvider } from './providers/anthropicUsageProvider.js';
import { ManualProvider } from './providers/manualProvider.js';
import { SessionTracker } from './core/sessionTracker.js';
import { BudgetEngine } from './core/budgetEngine.js';
import { scoreTurn, sessionSummary, type TurnScore } from './core/roiScorer.js';
import { writeReport, listReports } from './core/reportWriter.js';
import { StatusBar } from './ui/statusBar.js';
import { SidebarProvider } from './ui/sidebarPanel.js';
import { loadPriceTable } from './utils/priceTable.js';
import { log, disposeLogger } from './utils/logger.js';
import type { SessionState } from './core/sessionTracker.js';
import type { JournalEntry } from './providers/claudeCodeProvider.js';

export type DataSource = 'claude-code-logs' | 'anthropic-api' | 'manual' | 'none';

export function activate(context: vscode.ExtensionContext): void {
  log('Claude Lens activating');

  // 1. Load price table
  loadPriceTable(context.extensionPath);

  // 2. Config + store
  const workspaceConfig = new WorkspaceConfig();
  const store = new LocalStore(context);

  // 3. Session tracker — start time and window driven by data source, not by us
  const sessionTracker = new SessionTracker();

  // 4. Budget engine
  const budgetEngine = new BudgetEngine(store);

  // 5. ROI scorer state
  const turnScores: TurnScore[] = [];
  let lastPromptText   = '';
  let lastResponseText = '';
  let nudgeCooldownUntil = 0;

  // 6. Data source tracking (shown in sidebar so user knows where data comes from)
  let activeDataSource: DataSource = 'none';

  // 7. UI
  const statusBar = new StatusBar();
  const sidebarProvider = new SidebarProvider();
  vscode.window.registerTreeDataProvider('claudeLens.sidebar', sidebarProvider);

  const workspaceRoot = (): string =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function refreshUI(): void {
    const state        = sessionTracker.getState();
    const config       = workspaceConfig.get();
    const budgetReport = budgetEngine.evaluate(state, config);
    budgetEngine.alert(budgetReport, config);
    statusBar.update(state, budgetReport);
    sidebarProvider.update(state, budgetReport, config, sessionSummary(turnScores), activeDataSource);
  }

  function refreshReportsList(): void {
    const reports = listReports(workspaceConfig.get(), workspaceRoot());
    sidebarProvider.setReports(reports);
  }

  async function generateReport(state: SessionState): Promise<void> {
    const config = workspaceConfig.get();
    const root   = workspaceRoot();
    if (!root) return;
    const budgetReport = budgetEngine.evaluate(state, config);
    await writeReport({
      session: state, roiSummary: sessionSummary(turnScores),
      budgetReport, config, workspaceRoot: root,
    });
    refreshReportsList();
  }

  // ── Session tracker events ────────────────────────────────────────────────

  const onUpdate = sessionTracker.onUpdate(() => refreshUI());

  const onReset = sessionTracker.onReset(async completedState => {
    if (workspaceConfig.get().reports.auto_generate) {
      await generateReport(completedState);
    }
    turnScores.length = 0;
  });

  const onConfigChange = workspaceConfig.onDidChange(() => {
    refreshUI();
    refreshReportsList();
  });

  // ── Entry processing (shared by all providers) ────────────────────────────

  function processEntry(entry: JournalEntry): void {
    if (entry.type === 'user') {
      const content = (entry.message as Record<string, unknown>)['content'];
      if (typeof content === 'string') {
        lastPromptText = content;
      } else if (Array.isArray(content)) {
        lastPromptText = content
          .filter((b): b is { type: string; text: string } =>
            typeof b === 'object' && b !== null &&
            (b as Record<string, unknown>)['type'] === 'text'
          )
          .map(b => b.text)
          .join(' ');
      }
    }

    if (entry.type === 'assistant') {
      const content = (entry.message as Record<string, unknown>)['content'];
      if (typeof content === 'string') lastResponseText = content;
    }

    sessionTracker.ingestEntry(entry);

    // Score completed turns (assistant response received)
    if (entry.type === 'assistant' && entry.message.usage) {
      const state  = sessionTracker.getState();
      const config = workspaceConfig.get();
      const score  = scoreTurn(
        lastPromptText, lastResponseText, state.model,
        { input: entry.message.usage.input_tokens,
          output: entry.message.usage.output_tokens,
          cacheCreation: entry.message.usage.cache_creation_input_tokens,
          cacheRead: entry.message.usage.cache_read_input_tokens },
        state.turnCount, config
      );
      turnScores.push(score);

      // Advisory nudge — never modal, respects cooldown
      const now = Date.now();
      if (score.nudgeSuggestion && config.model_roi.nudge_on_overkill && now > nudgeCooldownUntil) {
        nudgeCooldownUntil = now + config.model_roi.nudge_cooldown_min * 60 * 1000;
        vscode.window
          .showInformationMessage(`⬡ ROI Nudge: ${score.nudgeSuggestion}`, 'Dismiss', "Don't Remind")
          .then(choice => {
            if (choice === "Don't Remind") nudgeCooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
          });
      }
      lastPromptText   = '';
      lastResponseText = '';
    }
  }

  // ── Provider 1: Claude Code JSONL logs ───────────────────────────────────
  // This is the primary source. Token data comes directly from Anthropic API
  // responses that Claude Code captures and writes to ~/.claude/projects/.

  const claudeProvider = new ClaudeCodeProvider();

  claudeProvider.onEntry(entry => processEntry(entry));

  // Provider tells us the REAL session start time from the first JSONL entry.
  // We use this — not extension activation time — to set the 5-hour window.
  claudeProvider.onSessionStart(startTime => {
    log(`Session start from JSONL: ${startTime.toISOString()}`);
    sessionTracker.beginSession(startTime);
  });

  // Provider tells us when Claude Code started a NEW session (new JSONL file).
  claudeProvider.onSessionEnd(() => {
    log('Claude Code started a new session — resetting tracker');
    sessionTracker.reset();
  });

  void (async () => {
    const sessionDir = await claudeProvider.discoverSessionDir();
    if (sessionDir) {
      activeDataSource = 'claude-code-logs';
      await claudeProvider.loadCurrentSession(sessionDir);
      claudeProvider.startWatching(sessionDir);
      log(`Claude Code provider active — data from ${sessionDir}`);
      refreshUI();
    } else {
      log('Claude Code logs not found — checking for Anthropic API key');
      await tryAnthropicApiProvider();
    }
  })();

  // ── Provider 2: Anthropic Usage API ──────────────────────────────────────
  // For users who use the API directly (not Claude Code).
  // Requires an Anthropic API key stored in VS Code SecretStorage.
  // Fetches real usage from https://api.anthropic.com/v1/usage
  // NOTE: this endpoint is for API/Workspace billing accounts only.
  // Claude Pro/Max subscription usage is NOT available via this API.

  const anthropicProvider = new AnthropicUsageProvider(context);

  async function tryAnthropicApiProvider(): Promise<void> {
    const hasKey = await anthropicProvider.hasApiKey();
    if (!hasKey) {
      log('No Anthropic API key — showing manual entry prompt');
      activeDataSource = 'none';
      refreshUI();
      return;
    }

    const ok = await anthropicProvider.fetchAndIngest(sessionTracker);
    if (ok) {
      activeDataSource = 'anthropic-api';
      anthropicProvider.startPolling(sessionTracker, 60_000); // poll every 60s
      log('Anthropic Usage API provider active');
      refreshUI();
    } else {
      activeDataSource = 'none';
      refreshUI();
    }
  }

  // ── Provider 3: Manual entry ──────────────────────────────────────────────
  const manualProvider = new ManualProvider(sessionTracker);

  // ── Workspace config ──────────────────────────────────────────────────────

  void workspaceConfig.load().then(config => {
    const root = workspaceRoot();
    sidebarProvider.setConfigFileExists(!!root && fs.existsSync(path.join(root, '.claudelens')));
    log(`Config loaded — project: "${config.project}"`);
    if (root) refreshReportsList();
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  const cmds = [
    vscode.commands.registerCommand('claudeLens.openHUD', () => {
      vscode.window.showInformationMessage('⬡ Claude Lens HUD — coming in Phase 3.');
    }),

    vscode.commands.registerCommand('claudeLens.generateReport', async () => {
      const state = sessionTracker.getState();
      if (state.turnCount === 0) {
        vscode.window.showInformationMessage('⬡ Claude Lens: No activity in this session yet.');
        return;
      }
      await generateReport(state);
    }),

    vscode.commands.registerCommand('claudeLens.openReportsFolder', () => {
      const config = workspaceConfig.get();
      const root   = workspaceRoot();
      if (!root) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const dir = path.isAbsolute(config.reports.output_dir)
        ? config.reports.output_dir
        : path.join(root, config.reports.output_dir);
      if (!fs.existsSync(dir)) {
        vscode.window.showInformationMessage('⬡ Claude Lens: No reports generated yet.'); return;
      }
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }),

    vscode.commands.registerCommand('claudeLens.resetSession', () => {
      sessionTracker.reset();
      vscode.window.showInformationMessage('⬡ Claude Lens: Session reset.');
    }),

    vscode.commands.registerCommand('claudeLens.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        '⬡ Claude Lens: Clear all local session history? This cannot be undone.',
        'Clear', 'Cancel'
      );
      if (confirm === 'Clear') {
        await store.clear();
        sessionTracker.reset();
        vscode.window.showInformationMessage('⬡ Claude Lens: History cleared.');
      }
    }),

    vscode.commands.registerCommand('claudeLens.openConfig', () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      void vscode.window.showTextDocument(
        vscode.Uri.file(path.join(folders[0].uri.fsPath, '.claudelens'))
      );
    }),

    vscode.commands.registerCommand('claudeLens.createConfig', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const configPath = path.join(folders[0].uri.fsPath, '.claudelens');
      if (fs.existsSync(configPath)) {
        void vscode.window.showTextDocument(vscode.Uri.file(configPath)); return;
      }
      const template = JSON.stringify({
        version: '1.0', project: path.basename(folders[0].uri.fsPath),
        budget: { session: 0.5, daily: 2.0, weekly: 10.0, currency: 'USD' },
        alerts: { soft_threshold: 0.8, hard_stop: false, notify_on_reset: true },
        model_roi: { enabled: true, preferred_model: 'sonnet', nudge_on_overkill: true, nudge_cooldown_min: 10 },
        reports: { auto_generate: true, output_dir: '.claudelens/reports', format: 'markdown',
                   client_billing_mode: false, client_name: '', billing_rate_usd: 0 },
      }, null, 2);
      fs.writeFileSync(configPath, template, 'utf-8');
      sidebarProvider.setConfigFileExists(true);
      void vscode.window.showTextDocument(vscode.Uri.file(configPath));
    }),

    vscode.commands.registerCommand('claudeLens.manualEntry', () => {
      void manualProvider.promptManualEntry();
    }),

    // Store API key in SecretStorage — never in plaintext, never in settings
    vscode.commands.registerCommand('claudeLens.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Claude Lens — Anthropic API Key',
        prompt: 'Enter your Anthropic API key (stored in VS Code SecretStorage only)',
        password: true,
        placeHolder: 'sk-ant-...',
        validateInput: v => v.startsWith('sk-ant-') ? undefined : 'Key should start with sk-ant-',
      });
      if (!key) return;
      await anthropicProvider.storeApiKey(key);
      vscode.window.showInformationMessage(
        '⬡ Claude Lens: API key saved. Activating Anthropic Usage API provider...'
      );
      await tryAnthropicApiProvider();
    }),

    vscode.commands.registerCommand('claudeLens.clearApiKey', async () => {
      await anthropicProvider.clearApiKey();
      vscode.window.showInformationMessage('⬡ Claude Lens: API key cleared.');
    }),
  ];

  context.subscriptions.push(
    onUpdate,
    { dispose: () => onReset.dispose() },
    onConfigChange,
    statusBar,
    claudeProvider,
    anthropicProvider,
    workspaceConfig,
    sidebarProvider,
    ...cmds
  );

  log('Claude Lens activated');
}

export function deactivate(): void {
  log('Claude Lens deactivating');
  disposeLogger();
}
