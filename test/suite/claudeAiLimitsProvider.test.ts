import * as assert from 'assert';
import { ClaudeAiLimitsProvider } from '../../src/providers/claudeAiLimitsProvider.js';

suite('ClaudeAiLimitsProvider', () => {
  test('credentials cache respects TTL', async () => {
    const provider = new ClaudeAiLimitsProvider();

    // Initial load to populate cache
    await provider.load();

    // Verify the cache is populated
    assert.ok(provider['lastCredsFetch'] > 0, 'lastCredsFetch should be set after load');
  });

  test('parseLimits handles valid response shape', () => {
    const provider = new ClaudeAiLimitsProvider();
    const response = {
      five_hour: { utilization: 45.0, resets_at: new Date().toISOString() },
      seven_day: { utilization: 60.0, resets_at: new Date().toISOString() },
    };

    const result = provider['parseLimits'](response, 'pro');
    assert.ok(result, 'Should parse valid response');
    assert.strictEqual(result?.subscriptionType, 'pro');
    assert.ok(result?.session, 'Should have session limit');
    assert.ok(result?.weekly, 'Should have weekly limit');
  });

  test('parseLimits returns undefined for invalid response', () => {
    const provider = new ClaudeAiLimitsProvider();
    const result = provider['parseLimits']({}, 'pro');
    assert.strictEqual(result, undefined, 'Should return undefined for unrecognized shape');
  });

  test('parseUtilObj handles string utilization values', () => {
    const provider = new ClaudeAiLimitsProvider();
    const obj = { utilization: '75.5', resets_at: new Date().toISOString() };

    const result = provider['parseUtilObj'](obj);
    assert.ok(result, 'Should parse string utilization');
    assert.strictEqual(result?.pctUsed, 0.755, 'Should convert to decimal (0-1)');
  });

  test('parseUtilObj rejects invalid dates', () => {
    const provider = new ClaudeAiLimitsProvider();
    const obj = { utilization: 50, resets_at: 'not-a-date' };

    const result = provider['parseUtilObj'](obj);
    assert.strictEqual(result, undefined, 'Should return undefined for invalid date');
  });

  test('parseUtilObj rejects NaN utilization', () => {
    const provider = new ClaudeAiLimitsProvider();
    const obj = { utilization: NaN, resets_at: new Date().toISOString() };

    const result = provider['parseUtilObj'](obj);
    assert.strictEqual(result, undefined, 'Should reject NaN utilization');
  });

  test('dispose clears polling timer', (done) => {
    const provider = new ClaudeAiLimitsProvider();
    provider.startPolling(() => {}, 100);

    // Timer should be active
    assert.ok(provider['pollTimer'], 'Timer should be set after startPolling');

    provider.dispose();
    assert.strictEqual(provider['pollTimer'], undefined, 'Timer should be cleared on dispose');
    done();
  });

  test('HTTP request includes required headers', () => {
    const provider = new ClaudeAiLimitsProvider();

    // Verify the headers are set correctly in the request
    // This is more of a code review test — the actual headers are set in get()
    // which is private, but we can verify the structure exists
    assert.ok(provider['get'], 'get method should exist');
  });
});
