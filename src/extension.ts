import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceConfig } from './config/workspaceConfig.js';
import { LocalStore } from './storage/localStore.js';
import { ClaudeCodeProvider } from './providers/claudeCodeProvider.js';
import { AnthropicUsageProvider } from './providers/anthropicUsageProvider.js';
import { SessionTracker } from './core/sessionTracker.js';
import { BudgetEngine } from './core/budgetEngine.js';
import { scoreTurn, sessionSummary, type TurnScore } from './core/roiScorer.js';
import { StatusBar } from './ui/statusBar.js';
import { SidebarProvider } from './ui/sidebarPanel.js';
import { ClaudeAiLimitsProvider } from './providers/claudeAiLimitsProvider.js';
import { getAvailableModels, setModel, clearModel, getActiveModel } from './core/modelSwitcher.js';
import { formatDuration } from './utils/formatter.js';
import { loadPriceTable } from './utils/priceTable.js';
import { log, disposeLogger } from './utils/logger.js';
import { notifyTurnQuotaUsage } from './ui/notifications.js';
import type { JournalEntry } from './providers/claudeCodeProvider.js';

export type DataSource = 'claude-code-logs' | 'anthropic-api' | 'none';

/**
 * Validates that a requested file path is within the workspace root.
 * Uses fs.realpath to resolve symlinks and prevent symlink-based escapes.
 */
async function validateWorkspaceFilePath(workspaceRoot: string, requestedPath: string): Promise<boolean> {
  try {
    // Resolve both paths through symlinks
    const realRoot = await fs.promises.realpath(workspaceRoot);

    // For new files that don't exist yet, resolve parent directory instead
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(requestedPath);
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        // File doesn't exist; resolve parent directory
        const parent = path.dirname(requestedPath);
        realPath = await fs.promises.realpath(parent);
        realPath = path.join(realPath, path.basename(requestedPath));
      } else {
        throw err;
      }
    }

    // Ensure the real path is within workspace (or equals workspace root)
    return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
  } catch (err) {
    log(`Path validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

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

  // ── Session tracker events ────────────────────────────────────────────────

  const onUpdate = sessionTracker.onUpdate(() => refreshUI());

  const onReset = sessionTracker.onReset(() => {
    turnScores.length = 0;
  });

  const onConfigChange = workspaceConfig.onDidChange(() => refreshUI());

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

      // Refresh quota immediately after each completed turn so the sidebar
      // reflects actual usage rather than waiting up to 5 minutes.
      void limitsProvider.refreshNow();

      // Calculate and display per-turn quota consumption
      const limits = limitsProvider.getLastData();
      const turnQuota = sessionTracker.calculateTurnQuotaPercentage(limits || { session: undefined, weekly: undefined, subscriptionType: '' });
      if (turnQuota && limits?.session) {
        notifyTurnQuotaUsage(turnQuota.pct, turnQuota.tokens, limits.session.pctUsed);
        // Store in session state for sidebar display (SessionTracker handles this internally)
        sessionTracker.setLastTurnQuotaUsage(turnQuota);
      }
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
    try {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[ERROR] Provider initialization failed: ${msg}`);
      vscode.window.showWarningMessage(
        '⬡ Claude Lens: Initialization warning — some data sources may be unavailable. Check the output channel.'
      );
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
      log('No Anthropic API key — no API provider available');
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

  // ── Provider 3: Claude.ai plan limits (session % / weekly %) ──────────────
  // Reads ~/.claude/.credentials.json and calls api.anthropic.com/api/oauth/usage
  // to get real subscription usage — same numbers shown on claude.ai/settings.
  // Polls every 5 min (endpoint rate-limits aggressively at shorter intervals).
  const limitsProvider = new ClaudeAiLimitsProvider();

  let lastSessionAlertPct = 0;  // tracks highest % we've already alerted on

  void limitsProvider.load().then(ok => {
    if (!ok) {
      log('ClaudeAiLimitsProvider: credentials not available');
      sidebarProvider.updatePlanLimits(null, limitsProvider.getLastError());
      return;
    }
    // Seed the sidebar with subscription type immediately from credentials
    // so the API Cost Estimate section starts collapsed for Pro/Max users
    // before the first API poll completes.
    const subType = limitsProvider.getSubscriptionType();
    if (subType) {
      const seed = { subscriptionType: subType, session: undefined, weekly: undefined };
      sidebarProvider.updatePlanLimits(seed);
      statusBar.updateLimits(seed);
    }
    limitsProvider.startPolling(limits => {
      sidebarProvider.updatePlanLimits(limits, limitsProvider.getLastError());
      statusBar.updateLimits(limits);
      if (!limits?.session) return;

      const sessionPct = Math.round(limits.session.pctUsed * 100);
      const weeklyPct = limits.weekly ? Math.round(limits.weekly.pctUsed * 100) : undefined;

      // Fire once per threshold crossing (80%, 90%) — never re-alert same level
      if (sessionPct >= 90 && lastSessionAlertPct < 90) {
        lastSessionAlertPct = 90;
        const resetsIn = formatDuration(Math.max(0, limits.session.resetAt.getTime() - Date.now()));
        const msg = weeklyPct !== undefined
          ? `⬡ Session at 90%, Weekly at ${weeklyPct}% — resets in ${resetsIn}`
          : `⬡ Claude session at 90% — resets in ${resetsIn}`;
        vscode.window
          .showWarningMessage(msg, 'View on claude.ai', 'Dismiss')
          .then(choice => {
            if (choice === 'View on claude.ai') {
              void vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/settings/usage'));
            }
          });
      } else if (sessionPct >= 80 && lastSessionAlertPct < 80) {
        lastSessionAlertPct = 80;
        const resetsIn = formatDuration(Math.max(0, limits.session.resetAt.getTime() - Date.now()));
        const msg = weeklyPct !== undefined
          ? `⬡ Session at 80%, Weekly at ${weeklyPct}% — resets in ${resetsIn}`
          : `⬡ Claude session at 80% — resets in ${resetsIn}`;
        vscode.window
          .showInformationMessage(msg, 'View on claude.ai', 'Dismiss')
          .then(choice => {
            if (choice === 'View on claude.ai') {
              void vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/settings/usage'));
            }
          });
      }

      // Reset alert level when session resets (sessionPct drops below previous alert)
      if (sessionPct < lastSessionAlertPct) {
        lastSessionAlertPct = 0;
      }
    }, 300_000);
  }).catch(err => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ERROR] ClaudeAiLimitsProvider initialization failed: ${msg}`);
  });

  // ── Workspace config ──────────────────────────────────────────────────────

  void workspaceConfig.load().then(async config => {
    try {
      const root = workspaceRoot();
      let configExists = false;
      if (root) {
        try {
          await fs.promises.access(path.join(root, '.claudelens'), fs.constants.R_OK);
          configExists = true;
        } catch {
          // Expected: config file may not exist yet; that's fine
        }
      }
      sidebarProvider.setConfigFileExists(configExists);
      log(`Config loaded — project: "${config.project}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[ERROR] Config initialization failed: ${msg}`);
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  const cmds = [
    vscode.commands.registerCommand('claudeLens.openHUD', () => {
      void vscode.commands.executeCommand('workbench.view.extension.claudeLens');
    }),

    vscode.commands.registerCommand('claudeLens.openClaudeAiUsage', () => {
      void vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/settings/usage'));
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

    vscode.commands.registerCommand('claudeLens.openConfig', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const workspaceRoot = folders[0].uri.fsPath;
      const configPath = path.join(workspaceRoot, '.claudelens');
      try {
        if (!(await validateWorkspaceFilePath(workspaceRoot, configPath))) {
          vscode.window.showErrorMessage('Invalid config path — must be within workspace.');
          return;
        }
      } catch (err) {
        log(`Path validation error: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage('Could not validate config path.');
        return;
      }
      void vscode.window.showTextDocument(vscode.Uri.file(configPath));
    }),

    vscode.commands.registerCommand('claudeLens.createConfig', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
      const workspaceRoot = folders[0].uri.fsPath;
      const configPath = path.join(workspaceRoot, '.claudelens');
      try {
        if (!(await validateWorkspaceFilePath(workspaceRoot, configPath))) {
          vscode.window.showErrorMessage('Invalid config path — must be within workspace.');
          return;
        }
      } catch (err) {
        log(`Path validation error: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage('Could not validate config path.');
        return;
      }
      try {
        await fs.promises.access(configPath, fs.constants.R_OK);
        void vscode.window.showTextDocument(vscode.Uri.file(configPath)); return;
      } catch { /* file doesn't exist — create it */ }
      const template = JSON.stringify({
        version: '1.0', project: path.basename(workspaceRoot),
        budget: { session: 0.5, daily: 2.0, weekly: 10.0, currency: 'USD' },
        alerts: { soft_threshold: 0.8, hard_stop: false, notify_on_reset: true },
        model_roi: { enabled: true, preferred_model: 'sonnet', nudge_on_overkill: true, nudge_cooldown_min: 10 },
      }, null, 2);
      await fs.promises.writeFile(configPath, template, 'utf-8');
      sidebarProvider.setConfigFileExists(true);
      void vscode.window.showTextDocument(vscode.Uri.file(configPath));
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

    vscode.commands.registerCommand('claudeLens.switchModel', async () => {
      const models  = getAvailableModels();
      const current = getActiveModel();
      const items   = [
        ...models.map(m => ({
          label:       m.label,
          description: m.id === current ? '← active' : '',
          id:          m.id,
        })),
        { label: 'Reset to default (Claude Code decides)', description: '', id: '' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title:        'Switch Claude Code model',
        placeHolder:  'Select model — writes to ~/.claude/settings.json',
      });
      if (!picked) return;
      if (picked.id === '') {
        clearModel();
        vscode.window.showInformationMessage('⬡ Claude Lens: Model preference cleared — Claude Code will use its default.');
      } else {
        setModel(picked.id);
        vscode.window.showInformationMessage(`⬡ Claude Lens: Model set to ${picked.id}. Takes effect on next Claude Code session.`);
      }
      sidebarProvider.refresh();
    }),
  ];

  context.subscriptions.push(
    onUpdate,
    { dispose: () => onReset.dispose() },
    onConfigChange,
    statusBar,
    claudeProvider,
    anthropicProvider,
    limitsProvider,
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
