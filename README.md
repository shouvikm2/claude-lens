# Claude Lens

> **Real-time Claude usage intelligence for VS Code — know your session limits before they hit you.**

A VS Code extension that shows your actual Claude Pro/Max subscription usage (session %, weekly %), live in the sidebar — the same numbers on claude.ai/settings, without switching windows.

Everything runs locally. Zero telemetry.

## Features at a glance

| Feature | What you see |
|---|---|
| **Plan Quota** | Live session % and weekly % from claude.ai/settings + proactive toasts at 80% and 90% |
| **API Cost Estimate** | Per-session, daily, weekly spend vs. configurable caps (useful for API users) |
| **Model ROI** | Smart suggestions to use cheaper models for simple tasks; avoid overspend |
| **Model Switching** | Switch models (Haiku/Sonnet/Opus) instantly without restarting — saved in ~/.claude/settings.json |

## UI Overview

![Claude Lens Sidebar](media/sidebar.png)

The sidebar shows:
- **Plan Quota** — real subscription usage % (from Anthropic API)
- **API Cost Estimate** — collapsed by default for Pro/Max users
- **Model ROI** — active model + suggestions
- **Session Detail** — token counts, cache, costs
- **Config** — data source, model switcher, settings

![Status Bar Demo](media/statusbar.png)

The status bar displays: quota %, time until reset, and active model. Click to focus the sidebar.

## How it works

**Data sources** (in priority order):
1. **Claude Code logs** — most accurate, local JSONL files
2. **Anthropic Usage API** — for workspace/API billing users (requires API key)
3. **Plan Quota** — reads oauth token for real subscription %, polls every 5 min

**Real-time updates**:
- Sidebar refreshes after each turn (rate-limited to 15s)
- Status bar updates on data provider changes
- Plan Quota refreshes every 5 minutes or on-demand after each turn

**Model ROI Scoring**: Each completed turn gets a complexity score (0–100) based on input tokens, output length, keywords ("architecture", "refactor", etc.), and conversation depth. Alerts nudge you when using a pricier model than necessary.

---

## Installation

### From the VS Code Marketplace

Search **Claude Lens** by `shouvikm`, or:

```bash
ext install shouvikm.claude-lens
```

## Setup

### 1. Open a workspace folder

Claude Lens is a per-project tool. Open your project folder in VS Code.

### 2. Create a `.claudelens` config

Run from the Command Palette (`Ctrl+Shift+P`):

```
Claude Lens: Create .claudelens
```

Scaffolds a config at your workspace root. Edit to set budget caps.

### 3. Start Claude Code

Claude Lens auto-discovers your active session. Sidebar and status bar update as you work.

**No API key required** for Claude Code users — token data comes from the local JSONL logs.

> Not using Claude Code? Run `Claude Lens: Set Anthropic API Key` for Anthropic API/Workspace billing accounts to track API usage.

---

## The `.claudelens` config file

Safe to commit — contains no secrets.

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
  }
}
```

### Config fields

**`budget`** — applies to API cost estimates (most relevant for direct API users)

| Field | Default | Description |
|---|---|---|
| `session` | `0.50` | Max API-equivalent spend per session |
| `daily` | `2.00` | Max spend per calendar day |
| `weekly` | `10.00` | Max spend per 7-day window |
| `currency` | `"USD"` | Display currency |

**`alerts`**

| Field | Default | Description |
|---|---|---|
| `soft_threshold` | `0.80` | Fraction of budget cap at which the amber warning fires |
| `hard_stop` | `false` | Show a blocking modal at 100% |
| `notify_on_reset` | `true` | Toast when the session window resets |

**`model_roi`**

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable/disable ROI scoring |
| `preferred_model` | `"sonnet"` | Baseline for overkill detection |
| `nudge_on_overkill` | `true` | Toast nudges when a more powerful model than needed is detected |
| `nudge_cooldown_min` | `10` | Minimum minutes between nudge toasts |

---

## Toast notifications

| Trigger | Type | Message |
|---|---|---|
| Plan quota hits 80% | Info | ⬡ Claude session at 80% — resets in Xh Ym |
| Plan quota hits 90% | Warning | ⬡ Claude session at 90% — resets in Xh Ym |
| API cost estimate hits soft threshold | Warning | ⬡ Budget Alert — approaching cap |
| API cost estimate hits 100% | Warning | ⬡ Budget Limit — cap reached |
| Model overkill detected | Info | ⬡ ROI Nudge — Sonnet recommended, nudges every 10 min |
| Session resets | Info | ⬡ Session window reset — token counters cleared |

---

## Commands

(`Ctrl+Shift+P` → **Claude Lens: ...**)

| Command | Description |
|---|---|
| `Open HUD` | Focus the Claude Lens sidebar |
| `Reset Session` | Clear current session counters (not Plan Quota) |
| `Clear Local History` | Wipe all stored session data from VS Code globalState |
| `Edit .claudelens` | Open the config file in the editor |
| `Create .claudelens` | Scaffold a new config at the workspace root |
| `Set Anthropic API Key` | Store API key in SecretStorage for Usage API provider |
| `Clear Anthropic API Key` | Remove stored API key |
| `Switch Claude Code Model` | QuickPick to change active model (writes to `~/.claude/settings.json`) |
| `View Usage on claude.ai` | Open https://claude.ai/settings/usage in browser |

---

## Pricing reference

Bundled in `resources/priceTable.json`. Never fetched from the network.

| Model | Input $/1M | Output $/1M | Cache Write $/1M | Cache Read $/1M |
|---|---|---|---|---|
| claude-opus-4-6 | $5.00 | $25.00 | $6.25 | $0.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-haiku-4-5-20251001 | $1.00 | $5.00 | $1.25 | $0.10 |
| claude-3-5-haiku-20241022 | $0.80 | $4.00 | $1.00 | $0.08 |

To override pricing, add to VS Code `settings.json`:

```json
"claudeLens.priceOverrides": {
  "claude-sonnet-4-6": {
    "inputPerMillion": 3.00,
    "outputPerMillion": 15.00,
    "cacheWritePerMillion": 3.75,
    "cacheReadPerMillion": 0.30
  }
}
```

---

## Privacy & Security

| Principle | Implementation |
|---|---|
| Minimal network calls | Two outbound calls: (1) `api.anthropic.com/api/oauth/usage` — read-only, using your existing Claude Code token. (2) Anthropic Usage API only if you explicitly provide an API key. All other data is local. |
| No telemetry | Zero usage tracking, crash reporting, or analytics |
| API key in SecretStorage only | If you provide an Anthropic API key, stored in VS Code SecretStorage — never in settings or `.claudelens` |
| OAuth token never stored by us | The Claude Code token is read from disk each poll and never written anywhere by Claude Lens |
| Local state only | Session data in VS Code `globalState` — never in the cloud |
| `.claudelens` is safe to commit | Contains no secrets or credentials |
| No hardcoded credentials | All secrets are read from secure sources at runtime |

---

## FAQ

**Q: Is my data stored in the cloud?**  
A: No. Session data lives only in VS Code's local `globalState`. Plan Quota data comes from a read-only Anthropic API call. Nothing is stored on our servers.

**Q: What if I switch models mid-session?**  
A: Claude Lens tracks the model active when each turn starts. If you switch in the Config section, the change applies to the *next* Claude Code session. Current session continues with the old model.

**Q: Why is the status bar timer different from Plan Quota?**  
A: Claude Code's JSONL file starts from when you opened the editor. Claude.ai's session window is server-managed and may have started at a different time. The Plan Quota "resets in" is authoritative.

**Q: Can I use Claude Lens with claude.ai directly (not Claude Code)?**  
A: Yes, with limitations. Set your Anthropic API key for Anthropic API/Workspace billing accounts to see API cost estimates. Plan Quota requires the OAuth token (via Claude Code). claude.ai-only subscribers should use Plan Quota for their subscription usage.

**Q: Does Claude Lens work offline?**  
A: Claude Code logs are local — yes. Plan Quota and Anthropic Usage API require internet — no. Sidebar gracefully shows "Fetching usage..." if offline.

---

## License

MIT — see [LICENSE](LICENSE).

---

*Built for developers who want to ship more without hitting the wall.*
