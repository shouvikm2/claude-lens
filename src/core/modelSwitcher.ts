import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../utils/logger.js';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Models available to Pro/Max Claude Code users.
// Claude Code routes to these via ~/.claude/settings.json "model" key.
const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6  (default — balanced)' },
  { id: 'claude-opus-4-6',            label: 'Opus 4.6    (most capable, slower)' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5   (fastest, lightest tasks)' },
] as const;

export type ModelId = typeof AVAILABLE_MODELS[number]['id'];

export function getActiveModel(): string | undefined {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return undefined;
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return typeof obj['model'] === 'string' ? obj['model'] : undefined;
  } catch {
    return undefined;
  }
}

export function setModel(modelId: string): void {
  let obj: Record<string, unknown> = {};
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      obj = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    // start fresh if file is corrupt
  }
  obj['model'] = modelId;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf-8');
  log(`ModelSwitcher: set model → ${modelId}`);
}

export function clearModel(): void {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const obj = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    delete obj['model'];
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    log('ModelSwitcher: cleared model preference (Claude Code will use default)');
  } catch {
    // ignore
  }
}

export function getAvailableModels(): ReadonlyArray<{ id: string; label: string }> {
  return AVAILABLE_MODELS;
}
