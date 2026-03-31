# Claude Lens — Project Reference

> **Cost intelligence and efficiency coaching for solo developers on paid Claude plans.**
> VS Code extension. MIT licensed. Zero telemetry. Everything local.

---

## Table of Contents

1. [Project Identity](#1-project-identity)
2. [Architecture Overview](#2-architecture-overview)
3. [Folder Structure](#3-folder-structure)
4. [Core Pillars](#4-core-pillars)
5. [Data Flow](#5-data-flow)
6. [Configuration — .claudelens](#6-configuration--claudelens)
7. [Module Reference](#7-module-reference)
8. [UI Specification](#8-ui-specification)
9. [Session Report Format](#9-session-report-format)
10. [Pricing Table](#10-pricing-table)
11. [Privacy Contract](#11-privacy-contract)
12. [Build & Publish](#12-build--publish)
13. [Development Rules](#13-development-rules)
14. [Phase Roadmap](#14-phase-roadmap)
15. [Competitive Differentiators](#15-competitive-differentiators)

---

## 1. Project Identity

| Field | Value |
|---|---|
| Extension name | `claude-lens` |
| Display name | Claude Lens |
| Publisher ID | `signaltosilicon` |
| Version | `0.1.0` |
| VS Code engine | `^1.85.0` |
| Language | TypeScript |
| License | MIT |
| Activation | `onStartupFinished` |
| Telemetry | **None. Zero. Never.** |

### Tagline
> *"Spend less. Ship more. Know the difference."*

### Target User
Solo developers on paid Claude plans (Pro, Max5, Max20) who want financial visibility, per-project budget control, model efficiency scoring, and exportable session cost reports — without any data leaving their machine.

### What Claude Lens Is NOT
- Not a token monitor (five already exist)
- Not a Claude Code replacement
- Not a cloud sync tool
- Not a team analytics platform (yet)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ claudeCode  │  │    manual    │  │  workspaceConf│  │
│  │  Provider   │  │   Provider   │  │  ig (.clens)  │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         └────────────────┴──────────────────┘           │
│                          │                              │
│                  ┌───────▼────────┐                     │
│                  │ sessionTracker │                     │
│                  │ (state machine)│                     │
│                  └───────┬────────┘                     │
│                          │                              │
│         ┌────────────────┼────────────────┐             │
│         ▼                ▼                ▼             │
│  ┌─────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │budgetEngine │  │ roiScorer  │  │ reportWriter   │   │
│  │ (PILLAR 1)  │  │ (PILLAR 2) │  │  (PILLAR 3)    │   │
│  └──────┬──────┘  └─────┬──────┘  └───────┬────────┘   │
│         └───────────────┴─────────────────┘             │
│                          │                              │
│         ┌────────────────┼────────────────┐             │
│         ▼                ▼                ▼             │
│  ┌─────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │  statusBar  │  │ sidebarPane│  │  hudWebview    │   │
│  │  (strip)    │  │  l (tree)  │  │  (charts)      │   │
│  └─────────────┘  └────────────┘  └────────────────┘   │
│                                                         │
│                  ┌─────────────────┐                    │
│                  │   localStore    │                    │
│                  │ (globalState    │                    │
│                  │  only, no files │                    │
│                  │  outside repo)  │                    │
│                  └─────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

**Rule:** No data crosses the network boundary. Ever. The only external calls permitted are to Anthropic's own API endpoints, using the user's own key, and only when explicitly opted in.

---

## 3. Folder Structure

```
claude-lens/
├── .claudelens                         # Example config (committed to this repo)
├── package.json                        # Extension manifest
├── tsconfig.json
├── .eslintrc.json
├── .vscodeignore
├── README.md
├── CHANGELOG.md
├── LICENSE
├── media/
│   ├── icon.png                        # 128x128, marketplace icon
│   ├── icon.svg                        # Source SVG
│   └── demo.gif                        # Marketplace demo GIF
├── resources/
│   └── priceTable.json                 # Hardcoded model pricing, user-overridable
├── src/
│   ├── extension.ts                    # Entry point — activate(), deactivate()
│   ├── core/
│   │   ├── sessionTracker.ts           # Token + session state machine
│   │   ├── budgetEngine.ts             # PILLAR 1 — caps, alerts, overrides
│   │   ├── roiScorer.ts                # PILLAR 2 — model fit heuristics
│   │   └── reportWriter.ts             # PILLAR 3 — markdown export
│   ├── config/
│   │   ├── workspaceConfig.ts          # Reads + watches .claudelens
│   │   ├── defaults.ts                 # Fallback config values
│   │   └── schema.ts                   # Config validation (Zod)
│   ├── providers/
│   │   ├── claudeCodeProvider.ts       # JSONL log reader + fs.watch
│   │   └── manualProvider.ts           # Fallback: user inputs tokens
│   ├── ui/
│   │   ├── statusBar.ts                # Bottom strip — always visible
│   │   ├── sidebarPanel.ts             # TreeView — full breakdown
│   │   ├── hudWebview.ts               # Floating panel — charts
│   │   └── webview/
│   │       ├── hud.html
│   │       ├── hud.css
│   │       └── hud.js                  # Chart.js — bundled, no CDN
│   ├── storage/
│   │   └── localStore.ts               # VSCode globalState wrapper
│   └── utils/
│       ├── tokenizer.ts                # gpt-tokenizer, local, no API
│       ├── priceTable.ts               # Pricing map + override logic
│       ├── formatter.ts                # Currency, time, percentage helpers
│       └── logger.ts                   # VSCode OutputChannel logger
├── test/
│   ├── suite/
│   │   ├── budgetEngine.test.ts
│   │   ├── roiScorer.test.ts
│   │   ├── reportWriter.test.ts
│   │   └── workspaceConfig.test.ts
│   └── runTests.ts
└── scripts/
    └── updatePriceTable.ts             # Manual script — never auto-runs
```

---

## 4. Core Pillars

### Pillar 1 — Workspace Budget Caps

Per-project spend limits defined in `.claudelens`. The first VS Code extension to let developers declare budget intent before a session starts.

**What it does:**
- Reads `budget.*` from `.claudelens` config
- Tracks spend in real time against session / daily / weekly caps
- Fires soft alert (toast + amber status bar) at configurable threshold (default 80%)
- Fires hard alert (red status bar + modal warning) at 100%
- Logs override reasons locally when user continues past hard alert
- Rolls up spend by workspace across VS Code globalState

**What it does NOT do:**
- Does not block Claude Code or any other tool
- Does not send spend data anywhere
- Does not share budgets across machines

---

### Pillar 2 — Model ROI Scoring

Heuristic engine that scores whether the active Claude model is appropriately matched to the current task. First tool in the space to do this at the IDE level.

**Scoring logic (all local, no API calls):**

```
Complexity score = f(
  prompt_token_count,
  code_context_lines,
  intent_keywords,        // ["fix", "explain", "refactor", "architect", "design"]
  response_token_count,
  session_turn_index
)

If complexity_score < THRESHOLD_FOR_MODEL:
  → flag as overkill
  → compute projected_saving = (model_cost - cheaper_model_cost) * tokens
  → emit nudge if overkill_count >= 2 in session
```

**Model tier thresholds (configurable):**

| Complexity Score | Recommended Model |
|---|---|
| 0–30 | haiku |
| 31–65 | sonnet |
| 66–100 | opus |

**Nudge rules:**
- Never nudge more than once per 10 minutes
- Never nudge during a turn in progress
- Always dismissable with one keypress
- Nudge text is advisory, never alarming

---

### Pillar 3 — Session Cost Reports

Auto-generated markdown files capturing every session's cost, model use, and activity. First VS Code extension to offer client-billing-mode export.

**Standard report content:**
- Session start / end timestamps
- Total duration
- Active model(s)
- Token breakdown: input / output / cached
- Cost breakdown: input cost / output cost / cache savings / net cost
- Files touched during session (from JSONL activity log)
- Task summary (last 3 user prompts, truncated to 100 chars each)
- ROI score summary
- Budget status at session end

**Client billing mode additions:**
- Project name from `.claudelens`
- Billable hours (session duration, rounded to 15-min increments)
- AI cost as line item formatted for invoice
- Standard disclaimer line

**Output location:** `.claudelens/reports/YYYY-MM-DD-HHMMSS.md`
Configurable via `reports.output_dir` in `.claudelens`.

---

## 5. Data Flow

### Primary Data Source — Claude Code JSONL Logs

Claude Code writes session data to `~/.claude/projects/<hash>/`. Each file is JSONL — one JSON object per line.

```typescript
// claudeCodeProvider.ts — core read pattern
interface JournalEntry {
  type:    'user' | 'assistant' | 'summary';
  message: {
    usage: {
      input_tokens:              number;
      output_tokens:             number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens:   number;
    };
    model: string;
  };
  timestamp: string;
}
```

**Watching for new entries:**
```typescript
// DO NOT use chokidar — unreliable in VS Code extensions
// USE VS Code's built-in FileSystemWatcher instead
const watcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(sessionDir, '*.jsonl')
);
watcher.onDidChange(uri => provider.reload(uri));
watcher.onDidCreate(uri => provider.load(uri));
```

**Session window:** Claude Code uses 5-hour rolling sessions. Budget engine must respect this boundary. A new session starts a new cost accumulation window.

### Fallback — Manual Provider

When Claude Code logs are not found (user is on claude.ai only, or API direct), show a compact input form in the sidebar allowing manual token entry. All math stays the same.

### Storage — VS Code globalState Only

```typescript
// localStore.ts — all reads and writes go through here
// Never write files outside .claudelens/reports/ (user-configured)
// Never use localStorage, sessionStorage, or any browser API

interface StoredState {
  sessions:     SessionRecord[];
  budgetTotals: BudgetTotals;
  roiHistory:   RoiRecord[];
  lastUpdated:  string;
}

context.globalState.update('claudeLens.state', state);
context.globalState.get<StoredState>('claudeLens.state');
```

---

## 6. Configuration — `.claudelens`

This file is the anchor feature. It makes Claude Lens a **project-level tool**, not just a personal gadget. It is designed to be committed to repos.

```json
{
  "version": "1.0",
  "project": "my-project-name",
  "budget": {
    "session":  0.50,
    "daily":    2.00,
    "weekly":   10.00,
    "currency": "USD"
  },
  "alerts": {
    "soft_threshold":   0.80,
    "hard_stop":        false,
    "notify_on_reset":  true
  },
  "model_roi": {
    "enabled":          true,
    "preferred_model":  "sonnet",
    "nudge_on_overkill": true,
    "nudge_cooldown_min": 10
  },
  "reports": {
    "auto_generate":      true,
    "output_dir":         ".claudelens/reports",
    "format":             "markdown",
    "client_billing_mode": false,
    "client_name":         "",
    "billing_rate_usd":    0
  }
}
```

**Config resolution order:**
1. `.claudelens` in current workspace root
2. VS Code extension settings (`settings.json`)
3. `defaults.ts` hardcoded fallback

**Schema validation:** Use Zod. Invalid `.claudelens` shows a one-time warning in the status bar and falls back to defaults. Never crashes the extension.

---

## 7. Module Reference

### `extension.ts`

Entry point. Registers all commands, providers, and UI components.

```typescript
export function activate(context: vscode.ExtensionContext): void {
  // 1. Load workspace config
  // 2. Initialize localStore
  // 3. Start claudeCodeProvider (file watcher)
  // 4. Initialize sessionTracker
  // 5. Mount budgetEngine, roiScorer, reportWriter
  // 6. Register statusBar, sidebarPanel, hudWebview
  // 7. Register commands
}

export function deactivate(): void {
  // Clean up file watchers
  // Flush any pending report writes
}
```

**Registered commands:**

| Command ID | Title | Description |
|---|---|---|
| `claudeLens.openHUD` | Open HUD | Opens the floating webview panel |
| `claudeLens.generateReport` | Generate Report Now | Forces report write |
| `claudeLens.resetSession` | Reset Session | Clears current session counters |
| `claudeLens.clearHistory` | Clear Local History | Wipes globalState |
| `claudeLens.openConfig` | Edit .claudelens | Opens config file in editor |
| `claudeLens.createConfig` | Create .claudelens | Scaffolds config in workspace root |

---

### `sessionTracker.ts`

State machine managing the current session's token and cost accumulation.

```typescript
interface SessionState {
  id:              string;       // UUID generated at session start
  startTime:       Date;
  model:           string;       // e.g. "claude-sonnet-4-6"
  tokens: {
    input:         number;
    output:        number;
    cacheCreation: number;
    cacheRead:     number;
    total:         number;
  };
  cost: {
    input:         number;
    output:        number;
    cacheCreation: number;
    cacheSavings:  number;
    net:           number;
  };
  turnCount:       number;
  resetTime:       Date;         // startTime + 5 hours
}
```

**Key methods:**
- `ingestEntry(entry: JournalEntry): void` — called by provider on each new JSONL line
- `getState(): SessionState` — snapshot for UI consumption
- `reset(): void` — called on 5-hour window expiry
- `onUpdate(cb: (state: SessionState) => void): Disposable` — event emitter for UI refresh

---

### `budgetEngine.ts`

Compares live session state against `.claudelens` budget config. Emits alerts.

```typescript
type BudgetStatus = 'ok' | 'soft_warn' | 'hard_warn' | 'over';

interface BudgetReport {
  session: { spent: number; cap: number; pct: number; status: BudgetStatus };
  daily:   { spent: number; cap: number; pct: number; status: BudgetStatus };
  weekly:  { spent: number; cap: number; pct: number; status: BudgetStatus };
  overall: BudgetStatus;
}

// Called on every sessionTracker update
function evaluate(state: SessionState, config: ClensConfig): BudgetReport

// Emits VSCode notifications
function alert(report: BudgetReport, prev: BudgetReport): void
```

**Alert behavior:**
- `soft_warn`: amber status bar + toast notification (dismissable, no modal)
- `hard_warn`: red status bar + toast with "Continue anyway?" action
- `over`: red status bar + persists until session resets
- Alerts do not fire more than once per status transition (soft fires once, hard fires once)

---

### `roiScorer.ts`

Heuristic model-fit scorer. Purely local. No ML, no API calls.

```typescript
interface TurnScore {
  complexityScore:  number;          // 0–100
  recommendedModel: ModelTier;       // 'haiku' | 'sonnet' | 'opus'
  activeModel:      ModelTier;
  isOverkill:       boolean;
  projectedSaving:  number;          // USD
  nudgeSuggestion:  string | null;   // Human-readable, or null if no nudge
}

// Scored on every completed turn (assistant response received)
function scoreTurn(
  prompt:     string,
  response:   string,
  model:      string,
  tokens:     TokenCounts,
  config:     ClensConfig
): TurnScore

// Session-level aggregation
function sessionSummary(turns: TurnScore[]): RoiSummary
```

**Complexity scoring heuristics:**

```typescript
const COMPLEXITY_SIGNALS = {
  // Prompt signals — increase score
  promptLength:      (tokens: number) => Math.min(tokens / 50, 20),
  architectureWords: ['design', 'architect', 'system', 'refactor', 'migrate'],
  codeContext:       (lines: number) => Math.min(lines / 20, 15),

  // Response signals — increase score
  responseLength:    (tokens: number) => Math.min(tokens / 100, 20),
  multiStepAnswer:   (text: string) => (text.match(/\d\./g)?.length ?? 0) * 2,

  // Session signals — decrease score (simple tasks repeat)
  turnIndex:         (n: number) => n > 5 ? -5 : 0,
  shortPrompt:       (tokens: number) => tokens < 20 ? -15 : 0,
};
```

---

### `reportWriter.ts`

Writes session cost reports to disk as markdown. Only module that writes files outside VS Code state.

```typescript
interface ReportOptions {
  session:       SessionState;
  roiSummary:    RoiSummary;
  budgetReport:  BudgetReport;
  config:        ClensConfig;
  filesChanged:  string[];      // from JSONL activity log
}

// Writes to config.reports.output_dir / YYYY-MM-DD-HHMMSS.md
async function writeReport(opts: ReportOptions): Promise<string>  // returns file path

// Generates weekly digest
async function writeWeeklyDigest(
  reports: ReportOptions[],
  outputDir: string
): Promise<string>
```

**File write rules:**
- Always write to user-configured `output_dir` only
- Never overwrite existing reports — use timestamp filename
- Create `output_dir` if it does not exist
- Emit VS Code info notification with "Open Report" action after write
- All writes are async, non-blocking

---

### `claudeCodeProvider.ts`

Reads and tails `~/.claude/projects/` JSONL session files.

```typescript
class ClaudeCodeProvider {
  private watchers: vscode.FileSystemWatcher[] = [];

  // Discovers all active session files for current workspace
  async discover(): Promise<vscode.Uri[]>

  // Loads a session file and emits parsed entries
  async load(uri: vscode.Uri): Promise<void>

  // Called by FileSystemWatcher on file change — reads new lines only
  async tail(uri: vscode.Uri, lastOffset: number): Promise<JournalEntry[]>

  // Cleans up all watchers on deactivate
  dispose(): void
}
```

**Session file discovery:**
```
~/.claude/projects/ 
  └── <workspace-hash>/
        └── <session-uuid>.jsonl   ← active sessions here
```

Workspace hash is derived from the VS Code workspace URI. Claude Code uses this same convention.

---

### `statusBar.ts`

Always-visible bottom strip. Renders in one of four states based on budget status.

```typescript
// Status bar item ID: claudeLens.status
// Priority: 100 (renders near left of right-side items)
// Alignment: vscode.StatusBarAlignment.Right

// Render templates:
// ok:        ⬡ $0.12/$0.50  ROI:✓  sonnet  ⏱2h14m
// soft_warn: ⬡ $0.42/$0.50  ROI:⚠  sonnet  ⏱0h44m   [amber background]
// hard_warn: ⬡ $0.49/$0.50  ROI:⚠  opus    ⏱0h31m   [orange background]
// over:      ⬡ OVER $0.50   ROI:✗  opus    ⏱0h18m   [red background]

// Click action: claudeLens.openHUD
// Tooltip: full breakdown on hover
// Refresh: every 30 seconds + on every sessionTracker update
```

---

### `workspaceConfig.ts`

Reads, validates, and watches `.claudelens` in the workspace root.

```typescript
class WorkspaceConfig {
  private config: ClensConfig;
  private watcher: vscode.FileSystemWatcher;

  // Initial load — falls back to defaults if file missing or invalid
  async load(): Promise<ClensConfig>

  // Called when .claudelens changes on disk — hot reloads without restart
  async reload(): Promise<void>

  // Returns the active config snapshot
  get(): ClensConfig

  // Emits when config changes
  onDidChange(cb: (config: ClensConfig) => void): vscode.Disposable
}
```

---

### `priceTable.ts`

Hardcoded pricing map. User can override in VS Code settings.

```typescript
// resources/priceTable.json — update manually when Anthropic changes pricing
// Script: scripts/updatePriceTable.ts — never runs automatically

export const PRICE_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-6': {
    inputPerMillion:         15.00,
    outputPerMillion:        75.00,
    cacheWritePerMillion:     3.75,
    cacheReadPerMillion:      1.50,
  },
  'claude-sonnet-4-6': {
    inputPerMillion:          3.00,
    outputPerMillion:        15.00,
    cacheWritePerMillion:     0.375,
    cacheReadPerMillion:      0.30,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMillion:          0.80,
    outputPerMillion:          4.00,
    cacheWritePerMillion:      0.10,
    cacheReadPerMillion:       0.08,
  },
};

// Cost calculation
export function calculateCost(tokens: TokenCounts, model: string): CostBreakdown
```

**IMPORTANT:** Never fetch pricing from the network automatically. Price table is updated manually via `scripts/updatePriceTable.ts` and committed. Users are notified via a status bar warning if their active model is not in the table.

---

## 8. UI Specification

### Status Bar

```
⬡ $0.12/$0.50  ROI:✓  sonnet-4-6  ⏱ 2h 14m
```

| Segment | Source | Color logic |
|---|---|---|
| `$0.12/$0.50` | budgetEngine session report | green < 80%, amber 80–99%, red ≥ 100% |
| `ROI:✓/⚠/✗` | roiScorer session summary | green = good fit, amber = minor overkill, red = significant overkill |
| `sonnet-4-6` | sessionTracker.model | static white |
| `⏱ 2h 14m` | sessionTracker.resetTime | static white, amber < 30min remaining |

---

### Sidebar Panel (TreeView)

```
CLAUDE LENS
│
├── 💰 Budget — {project name}
│   ├── Session:  $0.12 / $0.50  [████████░░] 24%
│   ├── Daily:    $0.84 / $2.00  [████████░░] 42%
│   ├── Weekly:   $4.32 / $10.00 [████████░░] 43%
│   └── Status:   ✓ comfortable
│
├── 🎯 Model ROI
│   ├── Active model:       claude-sonnet-4-6  ✓ good fit
│   ├── This session:       4 turns — 3 optimal, 1 overkill
│   ├── Overkill cost:      ~$0.04 this session
│   └── Weekly projection:  ~$1.20 saveable if optimized
│
├── 📋 Reports
│   ├── Last report:        today 11:42 AM
│   ├── This week:          6 reports generated
│   ├── [Generate Now]
│   └── [Open Reports Folder]
│
├── 📊 Session Detail
│   ├── Tokens in:          9,840
│   ├── Tokens out:         4,390
│   ├── Cache created:      2,100
│   ├── Cache read:         1,800
│   ├── Cache savings:      $0.01
│   └── Session started:    11:42 AM  (resets 4:42 PM)
│
└── ⚙ Config
    ├── .claudelens:        ✓ found
    ├── Budget caps:        active
    ├── ROI scoring:        active
    ├── Auto-reports:       active
    ├── [Edit .claudelens]
    └── [Create .claudelens]   ← shows only if file missing
```

---

### HUD Webview (Floating Panel)

Five cards rendered in a single row. All charts use Chart.js bundled locally — no CDN.

| Card | Content |
|---|---|
| Context Window | Progress ring, token counts, cache breakdown |
| Cost This Session | Input / output / cache savings / net / daily total / budget remaining |
| Burn Rate Sparkline | Token consumption per 10-min window, last 60 minutes, projected limit |
| Session Reset Timer | Circular countdown ring, started time, reset time |
| Active Model | Model name, plan tier, per-million-token rates, ROI fit badge |

**Webview security policy:**
```typescript
// hud.html — Content Security Policy
// meta http-equiv="Content-Security-Policy"
// content="default-src 'none';
//          script-src 'nonce-{nonce}';
//          style-src 'unsafe-inline';
//          img-src data:;"

// No external scripts. Chart.js is bundled into webview/hud.js at build time.
// No fetch() calls from the webview. All data passed via postMessage from extension host.
```

---

### Toast Notifications

| Trigger | Title | Body | Actions |
|---|---|---|---|
| 80% budget hit | ⬡ Budget Alert | "Session spend at 80% of $X.XX cap" | View Details, Dismiss |
| 100% budget hit | ⬡ Budget Limit | "Session cap of $X.XX reached" | Continue Anyway, Stop |
| Model overkill | ⬡ ROI Nudge | "Opus used for simple task. Sonnet saves ~$0.08/session" | Switch Model, Dismiss, Don't Remind |
| Report written | ⬡ Report Ready | "Session report saved to .claudelens/reports/" | Open Report, Open Folder |
| .claudelens missing | ⬡ No Config | "Add .claudelens to enable budget caps" | Create Config, Dismiss |

---

## 9. Session Report Format

### Standard Report — `YYYY-MM-DD-HHMMSS.md`

```markdown
# Claude Lens Session Report

**Project:** SmartCam v2  
**Date:** 2026-03-30  
**Session:** 11:42 AM → 2:14 PM (2h 32m)  
**Model:** claude-sonnet-4-6  

---

## Cost Summary

| Category       | Tokens    | Cost     |
|----------------|-----------|----------|
| Input          | 9,840     | $0.030   |
| Output         | 4,390     | $0.066   |
| Cache created  | 2,100     | $0.001   |
| Cache savings  | 1,800     | -$0.001  |
| **Net cost**   |           | **$0.096** |

**Budget status:** 19% of $0.50 session cap  
**Daily total:** $0.84 of $2.00 daily cap  

---

## ROI Summary

- Turns scored: 4
- Optimal turns: 3 (75%)
- Overkill turns: 1 (25%)
- Potential saving: ~$0.04 this session

---

## Activity

**Files touched:**
- `src/smartcam.py`
- `src/motion_detector.py`
- `config/pipeline.yaml`

**Session prompts (truncated):**
1. "Fix the sharpness gate threshold in detect_motion..."
2. "Add MOTION_COOLDOWN parameter to the pipeline..."
3. "Explain why the MJPEG stream drops frames at..."

---

*Generated by Claude Lens v0.1.0 — all data local, zero telemetry*
```

### Client Billing Report (when `client_billing_mode: true`)

Appends the following section:

```markdown
---

## Billing Summary

**Client:** Acme Corp  
**Project:** SmartCam Integration  
**Date:** 2026-03-30  

| Item                    | Hours | Rate     | Amount   |
|-------------------------|-------|----------|----------|
| Development (2h 32m)    | 2.5   | $150/hr  | $375.00  |
| AI tooling cost         | —     | at cost  | $0.10    |
| **Total**               |       |          | **$375.10** |

*AI cost reflects actual Claude API usage tracked by Claude Lens.*  
*Rounded to nearest 15 minutes.*
```

---

## 10. Pricing Table

Current as of extension version. Update via `scripts/updatePriceTable.ts` and commit.

| Model | Input $/1M | Output $/1M | Cache Write $/1M | Cache Read $/1M |
|---|---|---|---|---|
| claude-opus-4-6 | $15.00 | $75.00 | $3.75 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.375 | $0.30 |
| claude-haiku-4-5-20251001 | $0.80 | $4.00 | $0.10 | $0.08 |

**ROI model tiers:**
- `haiku` → complexity score 0–30
- `sonnet` → complexity score 31–65
- `opus` → complexity score 66–100

---

## 11. Privacy Contract

This is a first-class product commitment, not a footnote.

| Principle | Implementation |
|---|---|
| No telemetry | Zero usage tracking, crash reporting, or analytics. None. |
| No network calls | Extension makes no outbound requests except to Anthropic API when user explicitly opts in with their own key |
| Local state only | All session data stored in VS Code `globalState` — never written to cloud |
| Reports stay local | Session reports written only to user-configured `output_dir` on local filesystem |
| No PII collected | No usernames, emails, machine IDs, or workspace paths are stored or transmitted |
| Open source | Full source on GitHub — privacy claims are verifiable |
| Key storage | If user provides Anthropic API key, stored in VS Code `SecretStorage` — never plaintext |
| `.claudelens` design | Config file contains no sensitive data — safe to commit to public repos |

---

## 12. Build & Publish

### Prerequisites

```bash
node >= 18.0.0
npm >= 9.0.0
vsce >= 2.0.0          # npm install -g @vscode/vsce
```

### Development

```bash
npm install
npm run compile         # tsc — TypeScript compile
npm run watch           # tsc --watch for development
npm run lint            # eslint src/
npm run test            # Mocha test suite
F5 in VS Code           # Launch Extension Development Host
```

### Package

```bash
npm run compile
vsce package            # Produces claude-lens-0.1.0.vsix
```

### Publish

```bash
# VS Code Marketplace
vsce publish            # Requires PAT from marketplace.visualstudio.com

# Open VSX (VSCodium, Gitpod, Theia — same .vsix, double reach)
npx ovsx publish claude-lens-0.1.0.vsix -p <token>
```

### `package.json` — Key Manifest Fields

```json
{
  "name": "claude-lens",
  "displayName": "Claude Lens",
  "description": "Cost intelligence and efficiency coaching for Claude AI — budget caps, ROI scoring, billing reports. Local only, zero telemetry.",
  "version": "0.1.0",
  "publisher": "signaltosilicon",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other", "Visualization"],
  "keywords": ["claude", "anthropic", "ai", "cost", "budget", "token", "usage"],
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "claudeLens",
        "title": "Claude Lens",
        "icon": "media/icon.svg"
      }]
    },
    "views": {
      "claudeLens": [{
        "id": "claudeLens.sidebar",
        "name": "Claude Lens"
      }]
    }
  }
}
```

---

## 13. Development Rules

These rules are absolute. No exceptions.

1. **Zero breaking changes.** Every edit is surgical. Rationale stated before any file is touched.

2. **Privacy first, always.** Before adding any feature that touches data, ask: does this data leave the machine? If yes, do not ship it.

3. **No CDN calls from webview.** Chart.js and all dependencies must be bundled locally into `webview/hud.js` at build time. CSP enforces this.

4. **No file writes outside configured paths.** The only files Claude Lens writes are session reports in `reports.output_dir`. Nothing else. Ever.

5. **No auto-updates to price table.** Pricing is updated manually via `scripts/updatePriceTable.ts` and committed. Never fetched at runtime.

6. **VS Code FileSystemWatcher over chokidar.** chokidar is unreliable in VS Code extension host. Use `vscode.workspace.createFileSystemWatcher`.

7. **Zod for all config validation.** Invalid `.claudelens` falls back to defaults — never crashes. User sees a single warning toast.

8. **All async operations non-blocking.** File writes, JSONL reads, and report generation must never block the extension host thread.

9. **Nudges are advisory, never modal.** ROI nudges appear as dismissable toasts only. Never interrupt workflow with a modal.

10. **Test coverage for all three pillars.** `budgetEngine`, `roiScorer`, and `reportWriter` each require unit tests before Phase 1 ship. UI components do not require tests in Phase 1.

11. **API key in SecretStorage only.** If user provides Anthropic API key for optional precise token counting, store only in `context.secrets`. Never in `globalState`, `workspaceState`, or `.claudelens`.

12. **`.claudelens` contains no secrets.** The config file is designed to be safely committed to public repos. Document this explicitly in README.

---

## 14. Phase Roadmap

### Phase 1 — MVP (Ship this)

Target: working extension, publishable to marketplace.

- [x] Architecture designed
- [ ] `claudeCodeProvider.ts` — JSONL reader + FileSystemWatcher
- [ ] `sessionTracker.ts` — state machine
- [ ] `budgetEngine.ts` — cap evaluation + alerts
- [ ] `workspaceConfig.ts` — `.claudelens` reader + validator
- [ ] `localStore.ts` — globalState wrapper
- [ ] `statusBar.ts` — live strip
- [ ] `priceTable.ts` + `resources/priceTable.json`
- [ ] `extension.ts` — activation + command registration
- [ ] Unit tests: budgetEngine, workspaceConfig
- [ ] README with demo GIF
- [ ] Marketplace listing

**Phase 1 does NOT include:** HUD webview, ROI scorer, report writer, sidebar panel (basic version only)

---

### Phase 2 — Differentiation

- [ ] `roiScorer.ts` — heuristic model-fit engine
- [ ] `reportWriter.ts` — standard markdown reports
- [ ] Sidebar panel — full tree view with all five sections
- [ ] ROI nudge toasts
- [ ] Client billing mode (report format only)

---

### Phase 3 — Polish + HUD

- [ ] `hudWebview.ts` — floating panel
- [ ] Chart.js burn rate sparkline
- [ ] Session reset countdown ring
- [ ] Weekly digest report
- [ ] Manual provider fallback (for claude.ai-only users)

---

### Phase 4 — Marketplace Growth

- [ ] Open VSX publish (VSCodium, Gitpod)
- [ ] `.claudelens` schema JSON published for editor autocomplete
- [ ] CHANGELOG maintained per release
- [ ] GitHub Discussions enabled
- [ ] First 50 GitHub issues triaged and responded to

---

## 15. Competitive Differentiators

What Claude Lens owns that no other VS Code extension has as of March 2026:

| Capability | Claude Lens | Agent Lens | Claude Token Monitor | Damocles |
|---|---|---|---|---|
| Workspace budget caps via config file | ✅ | ❌ | ❌ | ❌ |
| Per-project `.claudelens` config | ✅ | ❌ | ❌ | ❌ |
| Model ROI scoring + overkill detection | ✅ | ❌ | ❌ | ❌ |
| Session markdown cost reports | ✅ | ❌ | ❌ | ❌ |
| Client billing mode export | ✅ | ❌ | ❌ | ❌ |
| Budget-aware status bar | ✅ | ❌ | ❌ | ❌ |
| Privacy-first as brand pillar | ✅ | ✅ | ❓ | ✅ |
| Zero telemetry (verifiable, open source) | ✅ | ✅ | ❓ | ✅ |

---

*Claude Lens — built under SignalToSilicon*  
*Privacy-first. Local-only. Open source.*  
*Last updated: 2026-03-30*
