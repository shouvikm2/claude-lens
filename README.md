# Claude Lens

> **Cost intelligence and efficiency coaching for solo developers on paid Claude plans.**
>
> *"Spend less. Ship more. Know the difference."*

A VS Code extension that gives you real-time financial visibility into your Claude AI usage — budget caps per project, model efficiency scoring, and auto-generated session cost reports. Everything runs locally on your machine. Zero telemetry. Zero network calls.

---

## What it does

| Pillar | What you get |
|---|---|
| **Budget Caps** | Per-session, daily, and weekly spend limits. Amber/red status bar + toast alerts when you approach or hit a cap. |
| **Model ROI Scoring** | Heuristic engine scores whether the active Claude model is appropriately matched to each task. Nudges you when using Opus for a Haiku-level question. |
| **Session Reports** | Auto-generated markdown files capturing every session's token counts, costs, files touched, and prompts. Optionally formatted for client billing. |

### What it is NOT

- Not a token counter (five already exist)
- Not a Claude Code replacement
- Not a cloud sync tool — your data never leaves your machine

---

## How it works

Claude Lens tries three data sources in order, using the first one that works:

| Priority | Source | Who it works for |
|---|---|---|
| 1 | **Claude Code JSONL logs** | Anyone using Claude Code — automatic, no config needed |
| 2 | **Anthropic Usage API** | API/Workspace billing accounts — requires your API key |
| 3 | **Manual entry** | claude.ai-only users — enter token counts via Command Palette |

### Source 1 — Claude Code logs (primary)

Claude Code writes each API response — including exact token counts direct from Anthropic's servers — to a local JSONL file after every turn:

```
~/.claude/projects/<workspace-hash>/<session-uuid>.jsonl
```

Each file is one Claude Code session. Claude Lens reads only the **current** (most recently modified) file, polls it every 2 seconds for new lines, and detects when Claude Code starts a new session file. The session start time and 5-hour window boundary are read from the first entry's timestamp — not from when the extension launched.

```
~/.claude/projects/<hash>/<current-session>.jsonl
        │
        │  (poll every 2s, session boundary from first entry timestamp)
        ▼
  claudeCodeProvider  ──onSessionStart──▶  sessionTracker.beginSession()
        │ onEntry
        ▼
  sessionTracker  ──→  budgetEngine  ──→  alerts + status bar
        │
        ├──→  roiScorer  ──→  nudge toasts
        │
        └──→  reportWriter  ──→  .claudelens/reports/YYYY-MM-DD-HHMMSS.md
```

### Source 2 — Anthropic Usage API (optional)

For users on API/Workspace billing plans who are not using Claude Code. Run:

```
Claude Lens: Set Anthropic API Key
```

The key is stored in VS Code **SecretStorage** — never in settings, never on disk in plaintext. Claude Lens then polls `api.anthropic.com/v1/usage` every 60 seconds.

> **Note:** This endpoint is for API/Workspace billing accounts only. Claude Pro/Max subscription usage is not available via any Anthropic API — JSONL logs are the only automated source for subscription users.

### Source 3 — Manual entry (fallback)

If neither source above is available, use **Claude Lens: Manual Token Entry** from the Command Palette. Select a model, enter input and output token counts. All budget and ROI math applies identically.

---

## Installation

### From the VS Code Marketplace

Search for **Claude Lens** by `shouvikm2` in the Extensions panel, or:

```
ext install shouvikm2.claude-lens
```

### From a `.vsix` file

```bash
code --install-extension claude-lens-0.1.0.vsix
```

---

## Setup

### 1. Open a workspace folder

Claude Lens is a per-project tool. Open your project folder in VS Code.

### 2. Create a `.claudelens` config

Run from the Command Palette (`Ctrl+Shift+P`):

```
Claude Lens: Create .claudelens
```

This scaffolds a config file at the root of your workspace. Edit it to set your budget caps.

### 3. Start Claude Code

Claude Lens automatically discovers and tails your active Claude Code session. The status bar and sidebar update as you work.

That's it. **No API key required** when using Claude Code — token data comes from the local logs Claude Code writes after every turn.

> Not using Claude Code? Run `Claude Lens: Set Anthropic API Key` if you're on an API/Workspace billing plan, or `Claude Lens: Manual Token Entry` for claude.ai-only usage.

---

## The `.claudelens` config file

This file lives at your workspace root and is designed to be **safely committed to your repo** — it contains no secrets.

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
    "enabled":            true,
    "preferred_model":    "sonnet",
    "nudge_on_overkill":  true,
    "nudge_cooldown_min": 10
  },
  "reports": {
    "auto_generate":       true,
    "output_dir":          ".claudelens/reports",
    "format":              "markdown",
    "client_billing_mode": false,
    "client_name":         "",
    "billing_rate_usd":    0
  }
}
```

### Config fields

**`budget`**

| Field | Default | Description |
|---|---|---|
| `session` | `0.50` | Max spend per 5-hour Claude Code session window |
| `daily` | `2.00` | Max spend per calendar day (rolling) |
| `weekly` | `10.00` | Max spend per 7-day window |
| `currency` | `"USD"` | Display currency (display only, math is always USD) |

**`alerts`**

| Field | Default | Description |
|---|---|---|
| `soft_threshold` | `0.80` | Fraction of cap at which the amber warning fires (0–1) |
| `hard_stop` | `false` | If true, shows a blocking modal at 100% (does not actually block Claude Code) |
| `notify_on_reset` | `true` | Toast notification when the 5-hour session window resets |

**`model_roi`**

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable/disable ROI scoring entirely |
| `preferred_model` | `"sonnet"` | Your usual model. Used as the baseline for overkill scoring. |
| `nudge_on_overkill` | `true` | Show toast nudges when a significantly over-powered model is detected |
| `nudge_cooldown_min` | `10` | Minimum minutes between nudge toasts |

**`reports`**

| Field | Default | Description |
|---|---|---|
| `auto_generate` | `true` | Auto-write a report when the 5-hour session window ends |
| `output_dir` | `".claudelens/reports"` | Where to write reports (relative to workspace root, or absolute) |
| `format` | `"markdown"` | Report format — only `"markdown"` supported currently |
| `client_billing_mode` | `false` | Appends a billing summary section to reports |
| `client_name` | `""` | Client name shown in the billing section |
| `billing_rate_usd` | `0` | Your hourly rate in USD for the billing section |

---

## UI guide

### Status bar

Always visible at the bottom-right. Click to open the HUD (Phase 3).

```
⬡ $0.12/$0.50  ROI:✓  sonnet-4-6  ⏱ 2h 14m
```

| Segment | Meaning |
|---|---|
| `$0.12/$0.50` | Session spend vs. cap — green < 80%, amber 80–99%, red ≥ 100% |
| `ROI:✓/⚠/✗` | Model fit — ✓ optimal, ⚠ minor overkill, ✗ significant overkill |
| `sonnet-4-6` | Active Claude model |
| `⏱ 2h 14m` | Time remaining in the 5-hour session window |

### Sidebar panel

Click the Claude Lens icon (⬡) in the activity bar.

```
CLAUDE LENS
│
├── 💰 Budget — {project}
│   ├── Session:  $0.12 / $0.50  [████░░░░░░] 24%
│   ├── Daily:    $0.84 / $2.00  [████░░░░░░] 42%
│   ├── Weekly:   $4.32 / $10.00 [████░░░░░░] 43%
│   └── Status:   ✓ comfortable
│
├── 🎯 Model ROI
│   ├── Active model:  sonnet-4-6  ✓ good fit
│   ├── This session:  4 turns — 3 optimal, 1 overkill
│   └── Overkill cost: ~$0.04 this session
│
├── 📊 Session Detail
│   ├── Tokens in:     9,840
│   ├── Tokens out:    4,390
│   ├── Cache created: 2,100
│   ├── Cache read:    1,800
│   ├── Cache savings: $0.01
│   └── Session started: 11:42 AM  (resets in 4h 32m)
│
├── 📋 Reports
│   ├── Last report:   2026-03-30 11:42
│   ├── This week:     6 reports generated
│   ├── ▶ Generate Now
│   └── 📁 Open Reports Folder
│
└── ⚙ Config
    ├── Data source:   ✓ Claude Code logs (local, exact)
    ├── .claudelens:   ✓ found
    ├── ✏ Edit .claudelens
    ├── + Create .claudelens   ← only shown if file missing
    └── 🔑 Set Anthropic API Key  ← only shown if not using Claude Code logs
```

### Toast notifications

| Trigger | Message |
|---|---|
| Spend reaches 80% of cap | ⬡ Budget Alert — amber toast with "View Details" |
| Spend reaches 100% of cap | ⬡ Budget Limit — warning toast with "Continue Anyway" |
| Model overkill detected | ⬡ ROI Nudge — advisory toast, dismissable, 10-min cooldown |
| Session report written | ⬡ Report Ready — info toast with "Open Report" and "Open Folder" |
| No `.claudelens` found | ⬡ No Config — with "Create Config" action |

---

## Session reports

Reports are written automatically when the 5-hour Claude Code session window expires, or on demand via **Claude Lens: Generate Report Now**.

**Example report** (`.claudelens/reports/20260330-114200.md`):

```markdown
# Claude Lens Session Report

**Project:** SmartCam v2
**Date:** 2026-03-30
**Session:** 11:42 AM → 2:14 PM (2h 32m)
**Model:** sonnet-4-6

---

## Cost Summary

| Category      | Tokens | Cost    |
|---------------|--------|---------|
| Input         | 9,840  | $0.030  |
| Output        | 4,390  | $0.066  |
| Cache created | 2,100  | $0.001  |
| Cache savings | 1,800  | -$0.001 |
| **Net cost**  |        | **$0.096** |

**Budget status:** 19% of $0.50 session cap
**Daily total:** $0.84 of $2.00 daily cap

---

## ROI Summary

- Turns scored: 4
- Optimal turns: 3 (75%)
- Overkill turns: 1 (25%)
- Potential saving: ~$0.040 this session
- Overall fit: ⚠ Minor overkill

---

## Activity

**Files touched:**
- `src/smartcam.py`
- `config/pipeline.yaml`

**Session prompts (truncated):**
1. "Fix the sharpness gate threshold in detect_motion..."
2. "Add MOTION_COOLDOWN parameter to the pipeline..."
3. "Explain why the MJPEG stream drops frames at..."

---

*Generated by Claude Lens v0.1.0 — all data local, zero telemetry*
```

### Client billing mode

Set `client_billing_mode: true` in `.claudelens` to append a billing section:

```markdown
## Billing Summary

**Client:** Acme Corp
**Project:** SmartCam Integration

| Item                  | Hours | Rate     | Amount   |
|-----------------------|-------|----------|----------|
| Development (2h 32m)  | 2.5   | $150/hr  | $375.00  |
| AI tooling cost       | —     | at cost  | $0.10    |
| **Total**             |       |          | **$375.10** |

*Development time rounded to nearest 15 minutes.*
```

---

## Commands

Access all commands via the Command Palette (`Ctrl+Shift+P`), prefixed with **Claude Lens**:

| Command | Description |
|---|---|
| `Claude Lens: Generate Report Now` | Write a session report immediately |
| `Claude Lens: Open Reports Folder` | Reveal the reports directory in your file manager |
| `Claude Lens: Reset Session` | Clear current session counters and start fresh |
| `Claude Lens: Clear Local History` | Wipe all stored session data from VS Code's globalState |
| `Claude Lens: Edit .claudelens` | Open the config file in the editor |
| `Claude Lens: Create .claudelens` | Scaffold a new config at the workspace root |
| `Claude Lens: Manual Token Entry` | Enter token counts manually (for non-Claude-Code workflows) |
| `Claude Lens: Set Anthropic API Key` | Store your API key in SecretStorage to enable the Usage API provider |
| `Claude Lens: Clear Anthropic API Key` | Remove the stored API key |

---

## Pricing reference

Hardcoded into the extension. Updated manually — never fetched from the network.

| Model | Input $/1M | Output $/1M | Cache Write $/1M | Cache Read $/1M |
|---|---|---|---|---|
| claude-opus-4-6 | $15.00 | $75.00 | $3.75 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.375 | $0.30 |
| claude-haiku-4-5-20251001 | $0.80 | $4.00 | $0.10 | $0.08 |

To override pricing for a model, add to your VS Code `settings.json`:

```json
"claudeLens.priceOverrides": {
  "claude-sonnet-4-6": {
    "inputPerMillion": 3.00,
    "outputPerMillion": 15.00,
    "cacheWritePerMillion": 0.375,
    "cacheReadPerMillion": 0.30
  }
}
```

---

## Privacy

| Principle | Implementation |
|---|---|
| No telemetry | Zero usage tracking, crash reporting, or analytics |
| Network calls only when you opt in | The only outbound request is to `api.anthropic.com/v1/usage` — only if you explicitly set an API key. Claude Code log mode makes zero network calls. |
| API key in SecretStorage only | If you provide an Anthropic API key, it is stored in VS Code SecretStorage — never in `settings.json`, `globalState`, or `.claudelens` |
| Local state only | All session data in VS Code `globalState` — never in the cloud |
| Reports stay local | Written only to your configured `output_dir` |
| No PII | No usernames, emails, machine IDs, or paths transmitted |
| Open source | Full source on GitHub — every claim is verifiable |
| `.claudelens` is safe to commit | Contains no secrets or credentials |

---

## Development

### Prerequisites

```
node >= 18.0.0
npm  >= 9.0.0
```

### Build and run

```bash
git clone https://github.com/shouvikm2/claude-lens
cd claude-lens
npm install
npm run compile

# Launch Extension Development Host
code --extensionDevelopmentPath=$(pwd)

# Or press F5 in VS Code after adding .vscode/launch.json
```

### Run tests

```bash
npm test
```

Test suites:
- `test/suite/budgetEngine.test.ts` — 7 tests
- `test/suite/workspaceConfig.test.ts` — 6 tests
- `test/suite/roiScorer.test.ts` — 10 tests
- `test/suite/reportWriter.test.ts` — 8 tests

### Watch mode

```bash
npm run watch
# In Extension Development Host: Ctrl+Shift+P → Developer: Reload Window
```

### Package

```bash
npm run compile
npx @vscode/vsce package
# Produces claude-lens-0.1.0.vsix
```

### Publish

```bash
# VS Code Marketplace (requires PAT from marketplace.visualstudio.com)
npx @vscode/vsce publish

# Open VSX — same .vsix, broader reach (VSCodium, Gitpod, Theia)
npx ovsx publish claude-lens-0.1.0.vsix -p <token>
```

---

## Roadmap

### ✅ Phase 1 — Core (shipped)
- JSONL log reader + polling watcher
- Session state machine (5-hour window)
- Budget engine — session / daily / weekly caps
- Alert system — soft and hard thresholds
- Status bar — live cost + ROI + model + timer
- Sidebar panel — budget, session detail, reports, config

### ✅ Phase 2 — Differentiation (shipped)
- ROI scorer — heuristic model-fit engine
- Session cost reports — auto-generated markdown
- Client billing mode
- Full sidebar with report history

### 🔲 Phase 3 — Polish + HUD
- Floating HUD webview with Chart.js charts
- Burn rate sparkline (last 60 minutes)
- Session reset countdown ring
- Context window progress ring

---

## License

MIT — see [LICENSE](LICENSE).

---

*Built with ❤ for developers who want to ship more and spend less.*
