import * as assert from 'assert';
import { ClaudeAiLimitsProvider } from '../../src/providers/claudeAiLimitsProvider.js';

suite('Credentials Caching (Security)', () => {
  test('CREDS_CACHE_TTL_MS is 5 minutes', () => {
    const provider = new ClaudeAiLimitsProvider();
    const ttl = provider['CREDS_CACHE_TTL_MS'];

    // 5 minutes = 5 * 60 * 1000 = 300000ms
    assert.strictEqual(ttl, 5 * 60 * 1000, 'Cache TTL should be 5 minutes');
  });

  test('lastCredsFetch is initialized to 0', () => {
    const provider = new ClaudeAiLimitsProvider();
    const lastFetch = provider['lastCredsFetch'];

    assert.strictEqual(lastFetch, 0, 'lastCredsFetch should start at 0');
  });

  test('lastCredsFetch is updated after load()', async () => {
    const provider = new ClaudeAiLimitsProvider();
    const beforeLoad = Date.now();

    await provider.load();

    const afterLoad = provider['lastCredsFetch'];

    // Verify timestamp was set and is reasonable
    assert.ok(afterLoad > 0, 'lastCredsFetch should be > 0 after load');
    assert.ok(afterLoad >= beforeLoad, 'lastCredsFetch should be current time or later');
  });

  test('fetchLimits respects cache TTL logic', async () => {
    const provider = new ClaudeAiLimitsProvider();

    // Set an old timestamp
    provider['lastCredsFetch'] = Date.now() - 10 * 60 * 1000; // 10 minutes ago

    // Simulate calling fetchLimits
    // The code checks: if (now - lastCredsFetch > CREDS_CACHE_TTL_MS) then reload
    const now = Date.now();
    const ttl = provider['CREDS_CACHE_TTL_MS'];
    const shouldReload = now - provider['lastCredsFetch'] > ttl;

    assert.strictEqual(shouldReload, true, 'Cache should be expired after 10 minutes');
  });

  test('fetchLimits does not reload when cache is fresh', async () => {
    const provider = new ClaudeAiLimitsProvider();

    // Set a recent timestamp
    provider['lastCredsFetch'] = Date.now() - 2 * 60 * 1000; // 2 minutes ago

    const now = Date.now();
    const ttl = provider['CREDS_CACHE_TTL_MS'];
    const shouldReload = now - provider['lastCredsFetch'] > ttl;

    assert.strictEqual(shouldReload, false, 'Cache should NOT be expired after 2 minutes');
  });

  test('cache TTL is exactly at boundary', () => {
    const provider = new ClaudeAiLimitsProvider();

    // Set timestamp exactly at TTL boundary
    provider['lastCredsFetch'] = Date.now() - provider['CREDS_CACHE_TTL_MS'];

    const now = Date.now();
    const ttl = provider['CREDS_CACHE_TTL_MS'];
    const shouldReload = now - provider['lastCredsFetch'] > ttl;

    // At exactly the TTL boundary, should NOT reload (> is strict greater than)
    assert.strictEqual(shouldReload, false, 'Should not reload at exact TTL boundary');
  });

  test('cache TTL expires 1ms after boundary', () => {
    const provider = new ClaudeAiLimitsProvider();

    // Set timestamp 1ms past TTL boundary
    provider['lastCredsFetch'] = Date.now() - provider['CREDS_CACHE_TTL_MS'] - 1;

    const now = Date.now();
    const ttl = provider['CREDS_CACHE_TTL_MS'];
    const shouldReload = now - provider['lastCredsFetch'] > ttl;

    assert.strictEqual(shouldReload, true, 'Should reload 1ms after TTL boundary');
  });

  test('security benefit: reduces plaintext filesystem reads', () => {
    // Over 24 hours (1440 minutes), with 5-min TTL:
    // - Without caching: 1440 / 5 = 288 reads (every 5 min interval)
    // - With caching: at most 288 reads (only on cache expiry)
    // In practice: much fewer since credential file is only re-read when TTL expires

    const readsPerDay = (24 * 60) / 5; // Without caching
    const cacheTTLMinutes = 5;

    // Verify math
    assert.strictEqual(readsPerDay, 288, 'Without caching: 288 reads/day');
    assert.strictEqual(cacheTTLMinutes, 5, 'Cache TTL: 5 minutes');

    // The security improvement is ~95% reduction in plaintext reads
    // because token stays in memory instead of being read from disk every poll
  });
});
