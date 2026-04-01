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

const ARCHITECTURE_WORDS = ['design', 'architect', 'system', 'refactor', 'migrate', 'infrastructure', 'scalab', 'restructure'];
const SIMPLE_WORDS       = ['fix', 'typo', 'rename', 'format', 'lint', 'what is', 'explain briefly'];

// Complexity → model tier thresholds (from spec)
const TIER_THRESHOLDS: { min: number; tier: ModelTier }[] = [
  { min: 66, tier: 'opus' },
  { min: 31, tier: 'sonnet' },
  { min: 0,  tier: 'haiku' },
];

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

  // Effective context size — up to 25 pts
  score += Math.min(effectiveInput / 50_000, 25);

  // Short prompt penalty: only fires if the ENTIRE context (incl. cache) is tiny.
  // A 2-token message with 1M cache reads is not a simple query.
  if (effectiveInput < 500) score -= 15;

  // Architecture / complexity keywords in prompt
  const lp = promptText.toLowerCase();
  if (ARCHITECTURE_WORDS.some(w => lp.includes(w))) score += 15;
  if (SIMPLE_WORDS.some(w => lp.includes(w)))       score -= 10;

  // Code context estimate: count lines in prompt
  const promptLines = (promptText.match(/\n/g) ?? []).length;
  score += Math.min(promptLines / 20, 15);

  // Response token length — up to 20 pts
  score += Math.min(tokens.output / 100, 20);

  // Multi-step response detection (numbered lists in response)
  const numberedSteps = (responseText.match(/\d+\./g) ?? []).length;
  score += Math.min(numberedSteps * 2, 10);

  // Later turns in a session tend to be simpler follow-ups
  if (turnIndex > 5) score -= 5;

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
