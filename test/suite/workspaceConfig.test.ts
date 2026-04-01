import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClensConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

suite('WorkspaceConfig / Schema', () => {
  test('valid .claudelens parses without error', () => {
    const input = {
      version: '1.0',
      project: 'test-project',
      budget: { session: 0.5, daily: 2.0, weekly: 10.0, currency: 'USD' },
      alerts: { soft_threshold: 0.8, hard_stop: false, notify_on_reset: true },
      model_roi: { enabled: true, preferred_model: 'sonnet', nudge_on_overkill: true, nudge_cooldown_min: 10 },
      reports: { auto_generate: true, output_dir: '.claudelens/reports', format: 'markdown', client_billing_mode: false, client_name: '', billing_rate_usd: 0 },
    };
    const result = ClensConfigSchema.safeParse(input);
    assert.ok(result.success, `Parse failed: ${!result.success ? result.error.message : ''}`);
    if (result.success) {
      assert.strictEqual(result.data.project, 'test-project');
      assert.strictEqual(result.data.budget.session, 0.5);
    }
  });

  test('invalid budget (negative) fails validation', () => {
    const input = {
      version: '1.0',
      project: 'test',
      budget: { session: -1, daily: 2.0, weekly: 10.0, currency: 'USD' },
      alerts: { soft_threshold: 0.8, hard_stop: false, notify_on_reset: true },
      model_roi: { enabled: true, preferred_model: 'sonnet', nudge_on_overkill: true, nudge_cooldown_min: 10 },
      reports: { auto_generate: true, output_dir: '.claudelens/reports', format: 'markdown', client_billing_mode: false, client_name: '', billing_rate_usd: 0 },
    };
    const result = ClensConfigSchema.safeParse(input);
    assert.ok(!result.success, 'Expected validation failure for negative budget');
  });

  test('invalid model_roi.preferred_model fails validation', () => {
    const input = {
      version: '1.0',
      project: 'test',
      budget: { session: 0.5, daily: 2.0, weekly: 10.0, currency: 'USD' },
      alerts: { soft_threshold: 0.8, hard_stop: false, notify_on_reset: true },
      model_roi: { enabled: true, preferred_model: 'gpt-4', nudge_on_overkill: true, nudge_cooldown_min: 10 },
      reports: { auto_generate: true, output_dir: '.claudelens/reports', format: 'markdown', client_billing_mode: false, client_name: '', billing_rate_usd: 0 },
    };
    const result = ClensConfigSchema.safeParse(input);
    assert.ok(!result.success, 'Expected validation failure for invalid model tier');
  });

  test('soft_threshold out of range fails validation', () => {
    const input = {
      version: '1.0',
      project: 'test',
      budget: { session: 0.5, daily: 2.0, weekly: 10.0, currency: 'USD' },
      alerts: { soft_threshold: 1.5, hard_stop: false, notify_on_reset: true },
      model_roi: { enabled: true, preferred_model: 'sonnet', nudge_on_overkill: true, nudge_cooldown_min: 10 },
      reports: { auto_generate: true, output_dir: '.claudelens/reports', format: 'markdown', client_billing_mode: false, client_name: '', billing_rate_usd: 0 },
    };
    const result = ClensConfigSchema.safeParse(input);
    assert.ok(!result.success, 'Expected validation failure for out-of-range soft_threshold');
  });

  test('DEFAULT_CONFIG is valid against schema', () => {
    const result = ClensConfigSchema.safeParse(DEFAULT_CONFIG);
    assert.ok(result.success, `DEFAULT_CONFIG failed validation: ${!result.success ? result.error.message : ''}`);
  });

  test('real .claudelens file in project root is valid', () => {
    // Read the example .claudelens in the repo root
    const configPath = path.resolve(__dirname, '../../../.claudelens');
    if (!fs.existsSync(configPath)) {
      // Skip if running outside the repo
      return;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const json: unknown = JSON.parse(raw);
    const result = ClensConfigSchema.safeParse(json);
    assert.ok(result.success, `Example .claudelens failed validation: ${!result.success ? result.error.message : ''}`);
  });

  test('writes to temp file and reads back correctly', () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `.claudelens-test-${Date.now()}`);
    const config = {
      version: '1.0',
      project: 'roundtrip-test',
      budget: { session: 1.0, daily: 5.0, weekly: 20.0, currency: 'USD' },
      alerts: { soft_threshold: 0.75, hard_stop: true, notify_on_reset: false },
      model_roi: { enabled: false, preferred_model: 'haiku', nudge_on_overkill: false, nudge_cooldown_min: 5 },
    };
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(config), 'utf-8');
      const raw = fs.readFileSync(tmpFile, 'utf-8');
      const parsed = ClensConfigSchema.safeParse(JSON.parse(raw));
      assert.ok(parsed.success);
      if (parsed.success) {
        assert.strictEqual(parsed.data.project, 'roundtrip-test');
        assert.strictEqual(parsed.data.budget.session, 1.0);
      }
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
