import * as vscode from 'vscode';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log, logError } from '../utils/logger.js';

export interface JournalEntry {
  type: 'user' | 'assistant' | 'summary';
  timestamp: string;
  message: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    model?: string;
    content?: unknown;
  };
}

type EntryCallback       = (entry: JournalEntry) => void;
type SessionStartCallback = (startTime: Date) => void;
type SessionEndCallback   = () => void;

const POLL_INTERVAL_MS = 2000;

export class ClaudeCodeProvider {
  private watchers: vscode.FileSystemWatcher[] = [];
  private fileOffsets = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | undefined;

  // The single JSONL file for the current Claude Code session
  private currentFile: string | undefined;

  private onEntryCallback:        EntryCallback        | undefined;
  private onSessionStartCallback: SessionStartCallback | undefined;
  private onSessionEndCallback:   SessionEndCallback   | undefined;

  /** Fires for every parsed journal entry in the current session. */
  onEntry(cb: EntryCallback): void { this.onEntryCallback = cb; }

  /**
   * Fires when we identify the real session start time from the first JSONL
   * entry's timestamp. This is what should drive the session window — not the
   * extension activation time.
   */
  onSessionStart(cb: SessionStartCallback): void { this.onSessionStartCallback = cb; }

  /**
   * Fires when a brand-new JSONL file appears, meaning Claude Code started a
   * new session. The tracker should reset before the new entries arrive.
   */
  onSessionEnd(cb: SessionEndCallback): void { this.onSessionEndCallback = cb; }

  // ── Startup ────────────────────────────────────────────────────────────────

  async discoverSessionDir(): Promise<string | undefined> {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    try {
      await fs.promises.access(claudeDir, fs.constants.R_OK);
    } catch {
      log('~/.claude/projects not found — Claude Code logs unavailable');
      return undefined;
    }
    return this.resolveSessionDirAsync(claudeDir);
  }

  /**
   * Load ONLY the most recent JSONL file (= the active Claude Code session).
   * We do not load historical files into live state — each file is one session.
   */
  async loadCurrentSession(sessionDir: string): Promise<void> {
    const latest = await this.findLatestJsonlAsync(sessionDir);
    if (!latest) {
      log('No JSONL session files found');
      return;
    }

    this.currentFile = latest;
    await this.loadFile(latest, /* announceStart */ true);
  }

  startWatching(sessionDir: string): void {
    // Primary: poll every 2s — reliable regardless of where the files live
    this.pollTimer = setInterval(() => this.pollAll(sessionDir), POLL_INTERVAL_MS);
    log(`Polling ${sessionDir} every ${POLL_INTERVAL_MS}ms`);

    // Secondary: FileSystemWatcher as a fast-path bonus (unreliable outside workspace)
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(sessionDir), '*.jsonl')
    );
    watcher.onDidChange(u => void this.tailAsync(u.fsPath));
    watcher.onDidCreate(u => void this.handleNewFile(u.fsPath));
    this.watchers.push(watcher);
  }

  dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  private pollAll(sessionDir: string): void {
    // Tail the current session file for new lines (async, non-blocking)
    if (this.currentFile) {
      void this.tailAsync(this.currentFile);
    }

    // Check whether Claude Code started a NEW session (new JSONL file)
    void this.findLatestJsonlAsync(sessionDir).then(latest => {
      if (latest && latest !== this.currentFile) {
        log(`New session file detected: ${path.basename(latest)}`);
        void this.handleNewFile(latest);
      }
    });
  }

  private async handleNewFile(filePath: string): Promise<void> {
    if (filePath === this.currentFile) return;

    // Signal the old session has ended
    this.onSessionEndCallback?.();

    // Track and load the new session file
    this.currentFile = filePath;
    await this.loadFile(filePath, /* announceStart */ true);
  }

  // ── File I/O ───────────────────────────────────────────────────────────────

  private async loadFile(filePath: string, announceStart: boolean): Promise<void> {
    try {
      const entries = await this.readAllLinesAsync(filePath);
      const stat = await fs.promises.stat(filePath);
      this.fileOffsets.set(filePath, stat.size);

      // Extract the real session start time from the first entry's timestamp.
      // This is what drives the 5-hour window — not our extension activation time.
      if (announceStart) {
        const firstTimestamp = this.extractFirstTimestamp(entries);
        if (firstTimestamp) {
          this.onSessionStartCallback?.(firstTimestamp);
        }
      }

      for (const entry of entries) {
        this.onEntryCallback?.(entry);
      }
      log(`Loaded ${entries.length} entries from ${path.basename(filePath)}`);
    } catch (err) {
      logError(`Failed to load ${filePath}`, err);
    }
  }

  private async tailAsync(filePath: string): Promise<void> {
    const lastOffset = this.fileOffsets.get(filePath) ?? 0;
    let fd: fsPromises.FileHandle | undefined;

    try {
      // Open file first, then check size to minimize TOCTOU window
      fd = await fs.promises.open(filePath, 'r');

      try {
        const stat = await fd.stat();

        // Handle file truncation: file smaller than last known offset
        if (stat.size < lastOffset) {
          log(`File ${path.basename(filePath)} was truncated (offset ${lastOffset} → size ${stat.size})`);
          this.fileOffsets.set(filePath, stat.size);
          return;
        }

        if (stat.size <= lastOffset) return;

        const length = stat.size - lastOffset;
        const buf = Buffer.alloc(length);
        const result = await fd.read(buf, 0, length, lastOffset);

        // Validate actual bytes read
        if (result.bytesRead < length) {
          log(`Partial read from ${path.basename(filePath)}: expected ${length}, got ${result.bytesRead}`);
        }

        // Update offset with actual bytes read, not expected
        this.fileOffsets.set(filePath, lastOffset + result.bytesRead);

        const newEntries = buf.slice(0, result.bytesRead).toString('utf-8')
          .split('\n')
          .filter(l => l.trim())
          .map(l => this.parseLine(l))
          .filter((e): e is JournalEntry => e !== undefined);

        for (const entry of newEntries) {
          this.onEntryCallback?.(entry);
        }
        if (newEntries.length > 0) {
          log(`Tailed ${newEntries.length} new entries from ${path.basename(filePath)}`);
        }
      } finally {
        await fd.close();
      }
    } catch (err) {
      logError(`Failed to tail ${filePath}`, err);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Returns the most recently modified JSONL file in sessionDir, or undefined. */
  private async findLatestJsonlAsync(sessionDir: string): Promise<string | undefined> {
    try {
      const dirEntries = await fs.promises.readdir(sessionDir);
      const jsonlFiles = dirEntries.filter(f => f.endsWith('.jsonl'));

      const filesWithMtime = await Promise.all(
        jsonlFiles.map(async f => {
          const full = path.join(sessionDir, f);
          const stat = await fs.promises.stat(full);
          return { full, mtime: stat.mtimeMs };
        })
      );

      filesWithMtime.sort((a, b) => b.mtime - a.mtime);
      return filesWithMtime[0]?.full;
    } catch {
      return undefined;
    }
  }

  /** Extracts the timestamp from the first parseable entry in the JSONL. */
  private extractFirstTimestamp(entries: JournalEntry[]): Date | undefined {
    for (const entry of entries) {
      if (entry.timestamp) {
        const d = new Date(entry.timestamp);
        if (!isNaN(d.getTime())) return d;
      }
    }
    return undefined;
  }

  // ── Directory resolution (unchanged) ──────────────────────────────────────

  private async resolveSessionDirAsync(claudeDir: string): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return undefined;
    const workspacePath = workspaceFolders[0].uri.fsPath;

    const byContent = await this.findDirByContentAsync(claudeDir, workspacePath);
    if (byContent) { log(`Session dir matched by content: ${byContent}`); return byContent; }

    const byName = await this.findDirByNameAsync(claudeDir, workspacePath);
    if (byName) { log(`Session dir matched by name: ${byName}`); return byName; }

    const fallback = await this.mostRecentProjectDirAsync(claudeDir);
    if (fallback) log(`Session dir fallback (most recent): ${fallback}`);
    return fallback;
  }

  private async findDirByContentAsync(claudeDir: string, workspacePath: string): Promise<string | undefined> {
    const normalized = workspacePath.replace(/\\/g, '/').toLowerCase();
    try {
      const dirEntries = await fs.promises.readdir(claudeDir, { withFileTypes: true });
      const projectDirs = dirEntries
        .filter(e => e.isDirectory())
        .map(e => path.join(claudeDir, e.name));

      for (const dirPath of projectDirs) {
        const files = await fs.promises.readdir(dirPath);
        const jsonlFiles = files
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(dirPath, f));
        for (const jf of jsonlFiles) {
          if (await this.fileContainsCwdAsync(jf, normalized)) return dirPath;
        }
      }
    } catch {
      // Expected: directory structure may not exist or be accessible
      // This is a best-effort search; failures are handled by fallback methods
    }
    return undefined;
  }

  private async fileContainsCwdAsync(filePath: string, normalizedCwd: string): Promise<boolean> {
    try {
      const buf = Buffer.alloc(8192);
      const fd = await fs.promises.open(filePath, 'r');
      const result = await fd.read(buf, 0, 8192, 0);
      await fd.close();
      const n = result.bytesRead;
      for (const line of buf.slice(0, n).toString('utf-8').split('\n').slice(0, 20)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const cwd = (obj['cwd'] as string | undefined)?.replace(/\\/g, '/').toLowerCase();
          if (cwd && (cwd === normalizedCwd || cwd.startsWith(normalizedCwd))) return true;
        } catch {
          // Expected: some lines may be malformed; skip and continue scanning
        }
      }
    } catch {
      // Expected: file may be unreadable, inaccessible, or deleted; caller handles failure
    }
    return false;
  }

  private async findDirByNameAsync(claudeDir: string, workspacePath: string): Promise<string | undefined> {
    const normalized = workspacePath.replace(/\\/g, '/');
    const candidates = new Set<string>([
      normalized.replace(/[^a-zA-Z0-9-]/g, '-'),
      normalized.replace(/\//g, '-'),
    ]);
    for (const c of [...candidates]) candidates.add(c.toLowerCase());

    try {
      const dirEntries = await fs.promises.readdir(claudeDir, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const { name } = entry;
        if (candidates.has(name) || candidates.has(name.toLowerCase())) {
          return path.join(claudeDir, name);
        }
        for (const c of candidates) {
          if (name.endsWith(c) || c.endsWith(name)) return path.join(claudeDir, name);
        }
      }
    } catch {
      // Expected: directory may not exist or be readable; caller has fallback
    }
    return undefined;
  }

  private async mostRecentProjectDirAsync(claudeDir: string): Promise<string | undefined> {
    try {
      const dirEntries = await fs.promises.readdir(claudeDir, { withFileTypes: true });
      const dirs = dirEntries.filter(e => e.isDirectory());

      const dirsWithMtime = await Promise.all(
        dirs.map(async e => {
          const fullPath = path.join(claudeDir, e.name);
          const stat = await fs.promises.stat(fullPath);
          return { dirPath: fullPath, mtime: stat.mtimeMs };
        })
      );

      dirsWithMtime.sort((a, b) => b.mtime - a.mtime);
      return dirsWithMtime[0]?.dirPath;
    } catch {
      // Expected: directory may not exist; caller has fallback
      return undefined;
    }
  }

  private async readAllLinesAsync(filePath: string): Promise<JournalEntry[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(l => l.trim())
      .map(l => this.parseLine(l))
      .filter((e): e is JournalEntry => e !== undefined);
  }

  private parseLine(line: string): JournalEntry | undefined {
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (parsed.type && parsed.message !== undefined) return parsed;
    } catch { /* skip */ }
    return undefined;
  }
}
