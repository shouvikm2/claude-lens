import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeReport, listReports } from '../../src/core/reportWriter.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { SessionState } from '../../src/core/sessionTracker.js';
import type { BudgetReport } from '../../src/core/budgetEngine.js';
import type { RoiSummary } from '../../src/core/roiScorer.js';
import type { ClensConfig } from '../../src/config/schema.js';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `claude-lens-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mockSession(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date('2026-03-30T11:42:00');
  return {
    id: 'test-session-id',
    startTime: now,
    endTime: new Date('2026-03-30T14:14:00'),
    model: 'claude-sonnet-4-6',
    tokens: { input: 9840, output: 4390, cacheCreation: 2100, cacheRead: 1800, total: 18130 },
    cost: { input: 0.030, output: 0.066, cacheCreation: 0.001, cacheSavings: 0.001, net: 0.096 },
    turnCount: 4,
    resetTime: new Date('2026-03-30T16:42:00'),
    recentPrompts: ['Fix the sharpness gate threshold', 'Add MOTION_COOLDOWN parameter', 'Explain frame drops'],
    filesChanged: ['src/smartcam.py', 'config/pipeline.yaml'],
    ...overrides,
  };
}

function mockBudget(): BudgetReport {
  return {
    session: { spent: 0.096, cap: 0.50, pct: 0.192, status: 'ok' },
    daily:   { spent: 0.84,  cap: 2.00, pct: 0.42,  status: 'ok' },
    weekly:  { spent: 4.32,  cap: 10.0, pct: 0.432, status: 'ok' },
    overall: 'ok',
  };
}

function mockRoi(): RoiSummary {
  return {
    turnsScored: 4, optimalTurns: 3, overkillTurns: 1,
    overkillPct: 0.25, totalProjectedSaving: 0.04, overallFit: 'minor_overkill',
  };
}

function configWithDir(outputDir: string, billing = false): ClensConfig {
  return {
    ...DEFAULT_CONFIG,
    project: 'SmartCam v2',
    reports: {
      ...DEFAULT_CONFIG.reports,
      output_dir: outputDir,
      auto_generate: true,
      client_billing_mode: billing,
      client_name: billing ? 'Acme Corp' : '',
      billing_rate_usd: billing ? 150 : 0,
    },
  };
}

suite('ReportWriter', () => {
  test('writes a markdown file to the output directory', async () => {
    const dir = tmpDir();
    try {
      const filePath = await writeReport({
        session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(dir), workspaceRoot: dir,
      });
      assert.ok(filePath, 'Expected a file path to be returned');
      assert.ok(fs.existsSync(filePath!), `File not found at ${filePath}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('report filename is formatted as YYYYMMDD-HHMMSS.md', async () => {
    const dir = tmpDir();
    try {
      const filePath = await writeReport({
        session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(dir), workspaceRoot: dir,
      });
      assert.ok(filePath);
      const basename = path.basename(filePath!);
      assert.match(basename, /^\d{8}-\d{6}\.md$/, `Unexpected filename: ${basename}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('report contains project name and cost summary', async () => {
    const dir = tmpDir();
    try {
      const filePath = await writeReport({
        session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(dir), workspaceRoot: dir,
      });
      const content = fs.readFileSync(filePath!, 'utf-8');
      assert.ok(content.includes('SmartCam v2'),         'Missing project name');
      assert.ok(content.includes('Cost Summary'),         'Missing cost section');
      assert.ok(content.includes('ROI Summary'),          'Missing ROI section');
      assert.ok(content.includes('Activity'),             'Missing activity section');
      assert.ok(content.includes('src/smartcam.py'),      'Missing file reference');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('report includes recent prompts', async () => {
    const dir = tmpDir();
    try {
      const filePath = await writeReport({
        session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(dir), workspaceRoot: dir,
      });
      const content = fs.readFileSync(filePath!, 'utf-8');
      assert.ok(content.includes('Fix the sharpness gate threshold'), 'Missing prompt 1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('client billing section appears when client_billing_mode is true', async () => {
    const dir = tmpDir();
    try {
      const filePath = await writeReport({
        session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(dir, true), workspaceRoot: dir,
      });
      const content = fs.readFileSync(filePath!, 'utf-8');
      assert.ok(content.includes('Billing Summary'), 'Missing billing section');
      assert.ok(content.includes('Acme Corp'),        'Missing client name');
      assert.ok(content.includes('$150'),             'Missing billing rate');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty session returns undefined and writes no file', async () => {
    const dir = tmpDir();
    try {
      const empty = mockSession({ turnCount: 0, cost: { input: 0, output: 0, cacheCreation: 0, cacheSavings: 0, net: 0 } });
      const filePath = await writeReport({
        session: empty, roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(dir), workspaceRoot: dir,
      });
      assert.strictEqual(filePath, undefined);
      assert.strictEqual(fs.readdirSync(dir).length, 0, 'Expected no files written for empty session');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('output directory is created if it does not exist', async () => {
    const base = tmpDir();
    const nested = path.join(base, 'deep', 'reports');
    try {
      const filePath = await writeReport({
        session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(),
        config: configWithDir(nested), workspaceRoot: base,
      });
      assert.ok(filePath);
      assert.ok(fs.existsSync(nested), 'Expected nested directory to be created');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('listReports returns files newest first', async () => {
    const dir = tmpDir();
    try {
      const config = configWithDir(dir);
      // Write two reports with a delay so timestamps differ
      await writeReport({ session: mockSession(), roiSummary: mockRoi(), budgetReport: mockBudget(), config, workspaceRoot: dir });
      await new Promise(r => setTimeout(r, 1100));
      const session2 = mockSession({ startTime: new Date(Date.now() - 1000) });
      await writeReport({ session: session2, roiSummary: mockRoi(), budgetReport: mockBudget(), config, workspaceRoot: dir });

      const reports = listReports(config, dir);
      assert.ok(reports.length >= 2, `Expected at least 2 reports, got ${reports.length}`);
      // Newest first — later filename comes first in reverse sort
      assert.ok(reports[0] > reports[1], 'Expected reports sorted newest first');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('listReports returns empty array when no reports exist', () => {
    const dir = tmpDir();
    try {
      const reports = listReports(configWithDir(path.join(dir, 'nonexistent')), dir);
      assert.deepStrictEqual(reports, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
