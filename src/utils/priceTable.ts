import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from './logger.js';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheSavings: number;
  net: number;
}

let baseTable: Record<string, ModelPricing> = {};

export function loadPriceTable(extensionPath: string): void {
  const tablePath = path.join(extensionPath, 'resources', 'priceTable.json');
  try {
    const raw = fs.readFileSync(tablePath, 'utf-8');
    baseTable = JSON.parse(raw) as Record<string, ModelPricing>;
    log(`Price table loaded — ${Object.keys(baseTable).length} models`);
  } catch (err) {
    logError('Failed to load priceTable.json', err);
  }
}

function getEffectiveTable(): Record<string, ModelPricing> {
  const overrides = vscode.workspace
    .getConfiguration('claudeLens')
    .get<Record<string, ModelPricing>>('priceOverrides', {});
  return { ...baseTable, ...overrides };
}

export function getPricing(model: string): ModelPricing | undefined {
  const table = getEffectiveTable();
  // Exact match first, then prefix match for model families
  if (table[model]) return table[model];
  const key = Object.keys(table).find(k => model.startsWith(k) || k.startsWith(model));
  return key ? table[key] : undefined;
}

export function isModelKnown(model: string): boolean {
  return getPricing(model) !== undefined;
}

export function calculateCost(tokens: TokenCounts, model: string): CostBreakdown {
  const pricing = getPricing(model);
  if (!pricing) {
    return { input: 0, output: 0, cacheCreation: 0, cacheSavings: 0, net: 0 };
  }

  const M = 1_000_000;
  const input = (tokens.input / M) * pricing.inputPerMillion;
  const output = (tokens.output / M) * pricing.outputPerMillion;
  const cacheCreation = (tokens.cacheCreation / M) * pricing.cacheWritePerMillion;
  // Cache savings = what would have cost as regular input minus cache read cost
  const cacheSavings =
    (tokens.cacheRead / M) * (pricing.inputPerMillion - pricing.cacheReadPerMillion);
  const net = input + output + cacheCreation - cacheSavings;

  return { input, output, cacheCreation, cacheSavings, net: Math.max(0, net) };
}

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export function modelToTier(model: string): ModelTier {
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

export function tierToExampleModel(tier: ModelTier): string {
  switch (tier) {
    case 'haiku': return 'claude-haiku-4-5-20251001';
    case 'opus': return 'claude-opus-4-6';
    case 'sonnet': return 'claude-sonnet-4-6';
  }
}
