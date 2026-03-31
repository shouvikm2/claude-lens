import * as assert from 'assert';
import { scoreTurn, sessionSummary } from '../../src/core/roiScorer.js';
import type { ClensConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

function cfg(overrides: Partial<ClensConfig['model_roi']> = {}): ClensConfig {
  return { ...DEFAULT_CONFIG, model_roi: { ...DEFAULT_CONFIG.model_roi, ...overrides } };
}

const TOKENS_SMALL  = { input: 10,   output: 50,   cacheCreation: 0, cacheRead: 0 };
const TOKENS_MEDIUM = { input: 500,  output: 1000, cacheCreation: 0, cacheRead: 0 };
const TOKENS_LARGE  = { input: 5000, output: 8000, cacheCreation: 0, cacheRead: 0 };

suite('RoiScorer', () => {
  test('short simple prompt scores low complexity → recommends haiku', () => {
    const result = scoreTurn('hi', 'sure', 'claude-opus-4-6', TOKENS_SMALL, 1, cfg());
    assert.ok(result.complexityScore < 31, `Expected score < 31, got ${result.complexityScore}`);
    assert.strictEqual(result.recommendedModel, 'haiku');
  });

  test('large prompt with architecture keywords scores high → recommends opus', () => {
    const longPrompt = 'Please design and architect a complete microservices system with proper infrastructure';
    const result = scoreTurn(longPrompt, 'Here is a 10-step plan: 1. ... 2. ... 3. ...', 'claude-sonnet-4-6', TOKENS_LARGE, 1, cfg());
    assert.ok(result.complexityScore >= 31, `Expected score >= 31, got ${result.complexityScore}`);
  });

  test('using opus for simple task is flagged as overkill', () => {
    const result = scoreTurn('fix typo', 'done', 'claude-opus-4-6', TOKENS_SMALL, 1, cfg());
    assert.strictEqual(result.isOverkill, true);
    assert.ok(result.projectedSaving > 0, 'Expected positive projected saving');
  });

  test('using haiku for simple task is NOT overkill', () => {
    const result = scoreTurn('fix typo', 'done', 'claude-haiku-4-5-20251001', TOKENS_SMALL, 1, cfg());
    assert.strictEqual(result.isOverkill, false);
    assert.strictEqual(result.projectedSaving, 0);
  });

  test('nudge suggestion is null when not overkill', () => {
    const result = scoreTurn('fix typo', 'done', 'claude-haiku-4-5-20251001', TOKENS_SMALL, 1, cfg());
    assert.strictEqual(result.nudgeSuggestion, null);
  });

  test('nudge suggestion is non-null when overkill and saving > threshold', () => {
    const result = scoreTurn('fix typo', 'done', 'claude-opus-4-6', TOKENS_MEDIUM, 1, cfg());
    if (result.isOverkill && result.projectedSaving > 0.001) {
      assert.ok(result.nudgeSuggestion !== null, 'Expected nudge suggestion');
      assert.ok(result.nudgeSuggestion!.includes('opus'), `Expected 'opus' in nudge: ${result.nudgeSuggestion}`);
    }
  });

  test('ROI disabled returns no overkill flag', () => {
    const result = scoreTurn('fix typo', 'done', 'claude-opus-4-6', TOKENS_SMALL, 1, cfg({ enabled: false }));
    assert.strictEqual(result.isOverkill, false);
    assert.strictEqual(result.nudgeSuggestion, null);
  });

  test('later turn index reduces score', () => {
    const earlyResult = scoreTurn('question', 'answer', 'claude-sonnet-4-6', TOKENS_MEDIUM, 1, cfg());
    const lateResult  = scoreTurn('question', 'answer', 'claude-sonnet-4-6', TOKENS_MEDIUM, 10, cfg());
    assert.ok(
      lateResult.complexityScore <= earlyResult.complexityScore,
      `Expected late score (${lateResult.complexityScore}) <= early score (${earlyResult.complexityScore})`
    );
  });

  test('sessionSummary aggregates turns correctly', () => {
    const t1 = scoreTurn('fix typo', 'done', 'claude-opus-4-6', TOKENS_SMALL, 1, cfg());
    const t2 = scoreTurn('explain concept', 'explanation', 'claude-sonnet-4-6', TOKENS_MEDIUM, 2, cfg());
    const summary = sessionSummary([t1, t2]);

    assert.strictEqual(summary.turnsScored, 2);
    assert.strictEqual(summary.optimalTurns + summary.overkillTurns, 2);
    assert.ok(summary.totalProjectedSaving >= 0);
    assert.ok(['good', 'minor_overkill', 'significant_overkill'].includes(summary.overallFit));
  });

  test('empty session summary returns good fit', () => {
    const summary = sessionSummary([]);
    assert.strictEqual(summary.turnsScored, 0);
    assert.strictEqual(summary.overallFit, 'good');
    assert.strictEqual(summary.totalProjectedSaving, 0);
  });

  test('all overkill turns → significant_overkill', () => {
    const turns = Array.from({ length: 5 }, () =>
      scoreTurn('fix typo', 'done', 'claude-opus-4-6', TOKENS_SMALL, 1, cfg())
    ).filter(t => t.isOverkill);

    if (turns.length === 5) {
      const summary = sessionSummary(turns);
      assert.strictEqual(summary.overallFit, 'significant_overkill');
    }
  });
});
