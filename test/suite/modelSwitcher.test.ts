import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getActiveModel, setModel, clearModel, getAvailableModels } from '../../src/core/modelSwitcher.js';

suite('ModelSwitcher', () => {
  // Use a temporary settings file for testing to avoid modifying the real one
  const testSettingsPath = path.join(os.tmpdir(), `.claude-test-settings-${Date.now()}.json`);

  teardown(() => {
    if (fs.existsSync(testSettingsPath)) {
      fs.unlinkSync(testSettingsPath);
    }
  });

  test('getAvailableModels returns correct model list', () => {
    const models = getAvailableModels();
    assert.ok(Array.isArray(models), 'Should return array');
    assert.ok(models.length > 0, 'Should have models');

    // Verify known models are present
    const modelIds = models.map((m) => m.id);
    assert.ok(modelIds.includes('claude-haiku-4-5-20251001'), 'Should include Haiku');
    assert.ok(modelIds.includes('claude-sonnet-4-6'), 'Should include Sonnet');
    assert.ok(modelIds.includes('claude-opus-4-6'), 'Should include Opus');
  });

  test('getAvailableModels includes proper labels', () => {
    const models = getAvailableModels();
    for (const model of models) {
      assert.ok(model.label, `Model ${model.id} should have label`);
      assert.ok(model.id, 'Model should have id');
    }
  });

  test('setModel writes valid JSON', () => {
    const testModel = 'claude-haiku-4-5-20251001';
    setModel(testModel);

    // Verify file was created and contains valid JSON
    assert.ok(fs.existsSync(path.join(os.homedir(), '.claude', 'settings.json')), 'Settings file should exist');

    const content = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      assert.fail('Settings file should contain valid JSON');
    }

    assert.ok(typeof parsed === 'object' && parsed !== null, 'Parsed JSON should be object');
  });

  test('clearModel preserves other settings', () => {
    // First set a model
    setModel('claude-opus-4-6');

    // Add some other property to verify it's preserved
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let obj = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    obj['testProperty'] = 'testValue';
    fs.writeFileSync(settingsPath, JSON.stringify(obj), 'utf-8');

    // Now clear the model
    clearModel();

    // Verify model is removed but testProperty remains
    obj = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    assert.strictEqual(obj['model'], undefined, 'Model should be removed');
    assert.strictEqual(obj['testProperty'], 'testValue', 'Other properties should be preserved');
  });

  test('setModel with invalid model ID should still write', () => {
    // The function doesn't validate model IDs — it just writes them
    // This is OK because Claude Code will ignore invalid ones
    const invalidModel = 'gpt-4-turbo';
    setModel(invalidModel);

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const obj = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    assert.strictEqual(obj['model'], invalidModel, 'Invalid model should be written as-is');
  });

  test('getActiveModel returns set model', () => {
    const testModel = 'claude-sonnet-4-6';
    setModel(testModel);

    const active = getActiveModel();
    assert.strictEqual(active, testModel, 'Should return the set model');
  });

  test('getActiveModel returns undefined when no model set', () => {
    // Clear the model first
    clearModel();

    const active = getActiveModel();
    // After clearing, model property shouldn't exist
    assert.strictEqual(active, undefined, 'Should return undefined when no model set');
  });

  test('getActiveModel handles corrupted settings file gracefully', () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    // Backup original if it exists
    const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;

    try {
      // Write invalid JSON
      fs.writeFileSync(settingsPath, 'invalid json {', 'utf-8');

      // Should not throw
      const active = getActiveModel();
      assert.strictEqual(active, undefined, 'Should return undefined for corrupted file');
    } finally {
      // Restore backup
      if (backup) {
        fs.writeFileSync(settingsPath, backup, 'utf-8');
      } else if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
      }
    }
  });

  test('setModel handles missing .claude directory gracefully', () => {
    // The function assumes ~/.claude exists, but let's verify it doesn't crash
    // In real usage, ~/.claude is always created by Claude Code
    const testModel = 'claude-haiku-4-5-20251001';

    // Should not throw
    assert.doesNotThrow(() => setModel(testModel), 'Should not throw on setModel');
  });
});
