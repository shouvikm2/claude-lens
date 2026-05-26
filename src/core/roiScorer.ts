import type { ClensConfig } from '../config/schema.js';
import type { TokenCounts } from '../utils/priceTable.js';
import { calculateCost, modelToTier, tierToExampleModel, type ModelTier } from '../utils/priceTable.js';

export interface TurnScore {
  complexityScore: number;       // 0–100
  recommendedModel: ModelTier;   // 'haiku' | 'sonnet' | 'opus'
  activeModel: ModelTier;
  isOverkill: boolean;
  projectedSaving: number;       // USD — saving if recommended model had been used
  nudgeSuggestion: string | null;
}

export interface RoiSummary {
  turnsScored: number;
  optimalTurns: number;
  overkillTurns: number;
  overkillPct: number;
  totalProjectedSaving: number;
  overallFit: 'good' | 'minor_overkill' | 'significant_overkill';
}

// Word boundaries required to avoid false matches (e.g., "suffix" contains "fix")
const ARCHITECTURE_WORDS = /\b(design|architect|system|refactor|migrate|infrastructure|scalab|restructure|optimization|performance|analysis|algorithm)\b/i;
const SIMPLE_WORDS       = /\b(fix|typo|rename|format|lint|explain|summarize|clarify|what is)\b/i;

// Complexity → model tier thresholds (from spec)
const TIER_THRESHOLDS: { min: number; tier: ModelTier }[] = [
  { min: 66, tier: 'opus' },
  { min: 31, tier: 'sonnet' },
  { min: 0,  tier: 'haiku' },
];

/** Count code lines (non-empty, non-comment) as signal of complexity */
function countCodeLines(text: string): number {
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    }).length;
}

/** Count actual multi-step instructions (numbered lists with content) */
function countRealSteps(text: string): number {
  // Match "N. <content>" patterns that are on separate lines (multi-step instructions)
  // Avoid inline counters like "1. 2. 3." by requiring line breaks or substantial content after
  const stepPattern = /\n\s*\d+\.\s+.{2,200}/g;
  const matches = text.match(stepPattern);
  return matches ? Math.min(matches.length, 15) : 0;
}

/** Estimate semantic complexity of fresh input (not cache) */
function estimateFreshInputComplexity(promptText: string): number {
  // Truncate to prevent ReDoS on very large inputs
  const capped = promptText.length > 10_000 ? promptText.slice(0, 10_000) : promptText;
  // Remove markdown code blocks by splitting on triple-backtick fences
  const parts = capped.split('```');
  // Keep only odd-indexed parts (outside code blocks)
  const stripped = parts.filter((_, i) => i % 2 === 0).join(' ').toLowerCase();

  const words = stripped.split(/\s+/).length;
  // 0-10 words: trivial, 50+ words: complex narrative
  return Math.min(words / 50, 1) * 15;
}

function scoreComplexity(
  promptText: string,
  responseText: string,
  tokens: TokenCounts,
  turnIndex: number
): number {
  let score = 0;

  // In Claude Code sessions almost all input arrives via cache reads — the
  // raw input_tokens count is nearly zero (just the new message) while
  // cache_read_input_tokens carries the full context window. Use total
  // effective context as the complexity signal.
  const effectiveInput = tokens.input + (tokens.cacheCreation ?? 0) + (tokens.cacheRead ?? 0);
  const cacheRatio = tokens.cacheRead ? tokens.cacheRead / effectiveInput : 0;

  // [IMPROVED] Effective context size — up to 25 pts
  // Heavy cache reuse (>90%) gets modest boost: context is maintained but query is fresh.
  // This avoids over-rewarding turns that reuse massive amounts of cached code.
  if (cacheRatio > 0.9) {
    score += Math.min(effectiveInput / 100_000, 15); // Dampen for high cache reuse
  } else {
    score += Math.min(effectiveInput / 50_000, 25); // Full signal for fresh context
  }

  // [IMPROVED] Short fresh input penalty: only fires if NEW input (not cache) is tiny
  // Previously: penalized any turn with < 500 total effective tokens
  // Now: only penalize if fresh input is < 50 AND total context is < 500
  // This avoids false positives like "continue debugging" + 10M cached code files
  if (tokens.input < 50 && effectiveInput < 500) {
    score -= 15;
  }

  // [IMPROVED] Architecture / complexity keywords — word boundaries + regex
  // Previously: used .includes() which matched "suffix" for "fix", "platform" for "form"
  // Now: use word boundary regex \b to avoid substring matches
  if (ARCHITECTURE_WORDS.test(promptText)) score += 15;
  if (SIMPLE_WORDS.test(promptText)) score -= 10;

  // [IMPROVED] Code context estimate: count actual code lines (not just newlines)
  // Previously: counted all newlines, including blank lines and comments
  // Now: ignores empty lines and single-line comments (//, #)
  const codeLines = countCodeLines(promptText);
  score += Math.min(codeLines / 20, 15);

  // [NEW] Fresh input semantic complexity (ignore boilerplate)
  // Counts words in fresh prompt (not code blocks), scales 0-15 pts
  // Distinguishes between trivial 2-word queries and complex 100-word narratives
  score += estimateFreshInputComplexity(promptText);

  // Response token length — up to 20 pts
  score += Math.min(tokens.output / 100, 20);

  // [IMPROVED] Multi-step response detection (real instructions, not inline numbers)
  // Previously: counted any "N." pattern, including inline numbers ("cost: $5. next: $10.")
  // Now: only counts line-break delimited steps (structured multi-step responses)
  const realSteps = countRealSteps(responseText);
  score += Math.min(realSteps * 1, 10);

  // [IMPROVED] Later turn penalty: smoother decay curve
  // Previously: flat -5 after turn 5
  // Now: gradual -3 at turn 6-10, then -7 for 11+ (compound effect of follow-ups)
  if (turnIndex > 10) {
    score -= 7;
  } else if (turnIndex > 5) {
    score -= 3;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function complexityToTier(score: number): ModelTier {
  return (TIER_THRESHOLDS.find(t => score >= t.min) ?? TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1]).tier;
}

function projectedSaving(tokens: TokenCounts, activeModel: string, recommendedTier: ModelTier): number {
  if (modelToTier(activeModel) === recommendedTier) return 0;
  const recommendedModel = tierToExampleModel(recommendedTier);
  const activeCost     = calculateCost(tokens, activeModel).net;
  const recommendedCost = calculateCost(tokens, recommendedModel).net;
  return Math.max(0, activeCost - recommendedCost);
}

function nudgeText(
  activeModel: string,
  recommended: ModelTier,
  saving: number
): string {
  const activeTier = modelToTier(activeModel);
  const savingStr  = saving > 0.001 ? ` Saves ~$${saving.toFixed(3)}/turn.` : '';
  return `${activeTier} used for a ${recommended}-complexity task.${savingStr} Consider switching to ${recommended}.`;
}

export function scoreTurn(
  promptText: string,
  responseText: string,
  model: string,
  tokens: TokenCounts,
  turnIndex: number,
  config: ClensConfig
): TurnScore {
  if (!config.model_roi.enabled) {
    return {
      complexityScore: 0,
      recommendedModel: modelToTier(model),
      activeModel: modelToTier(model),
      isOverkill: false,
      projectedSaving: 0,
      nudgeSuggestion: null,
    };
  }

  const complexityScore  = scoreComplexity(promptText, responseText, tokens, turnIndex);
  const recommendedModel = complexityToTier(complexityScore);
  const activeModel      = modelToTier(model);
  const isOverkill       = activeModel !== recommendedModel &&
    (['haiku', 'sonnet', 'opus'] as ModelTier[]).indexOf(activeModel) >
    (['haiku', 'sonnet', 'opus'] as ModelTier[]).indexOf(recommendedModel);

  const saving = isOverkill
    ? projectedSaving(tokens, model, recommendedModel)
    : 0;

  const nudgeSuggestion =
    isOverkill && saving > 0.001
      ? nudgeText(model, recommendedModel, saving)
      : null;

  return { complexityScore, recommendedModel, activeModel, isOverkill, projectedSaving: saving, nudgeSuggestion };
}

export function sessionSummary(turns: TurnScore[]): RoiSummary {
  const turnsScored  = turns.length;
  const overkillTurns = turns.filter(t => t.isOverkill).length;
  const optimalTurns  = turnsScored - overkillTurns;
  const overkillPct   = turnsScored > 0 ? overkillTurns / turnsScored : 0;
  const totalProjectedSaving = turns.reduce((s, t) => s + t.projectedSaving, 0);

  let overallFit: RoiSummary['overallFit'] = 'good';
  if (overkillPct >= 0.5) overallFit = 'significant_overkill';
  else if (overkillPct >= 0.2) overallFit = 'minor_overkill';

  return { turnsScored, optimalTurns, overkillTurns, overkillPct, totalProjectedSaving, overallFit };
}
