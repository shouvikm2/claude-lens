import * as vscode from 'vscode';
import * as fs from 'fs';
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
    if (!fs.existsSync(claudeDir)) {
      log('~/.claude/projects not found — Claude Code logs unavailable');
      return undefined;
    }
    return this.resolveSessionDir(claudeDir);
  }

  /**
   * Load ONLY the most recent JSONL file (= the active Claude Code session).
   * We do not load historical files into live state — each file is one session.
   */
  async loadCurrentSession(sessionDir: string): Promise<void> {
    const latest = this.findLatestJsonl(sessionDir);
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
    watcher.onDidChange(u => this.tail(u.fsPath));
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
    // Tail the current session file for new lines
    if (this.currentFile) {
      this.tail(this.currentFile);
    }

    // Check whether Claude Code started a NEW session (new JSONL file)
    const latest = this.findLatestJsonl(sessionDir);
    if (latest && latest !== this.currentFile) {
      log(`New session file detected: ${path.basename(latest)}`);
      void this.handleNewFile(latest);
    }
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
      const entries = this.readAllLines(filePath);
      this.fileOffsets.set(filePath, fs.statSync(filePath).size);

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

  private tail(filePath: string): void {
    const lastOffset = this.fileOffsets.get(filePath) ?? 0;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= lastOffset) return;

      const fd = fs.openSync(filePath, 'r');
      const length = stat.size - lastOffset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, lastOffset);
      fs.closeSync(fd);
      this.fileOffsets.set(filePath, stat.size);

      const newEntries = buf.toString('utf-8')
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
    } catch (err) {
      logError(`Failed to tail ${filePath}`, err);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Returns the most recently modified JSONL file in sessionDir, or undefined. */
  private findLatestJsonl(sessionDir: string): string | undefined {
    try {
      const files = fs.readdirSync(sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const full = path.join(sessionDir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return files[0]?.full;
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

  private resolveSessionDir(claudeDir: string): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return undefined;
    const workspacePath = workspaceFolders[0].uri.fsPath;

    const byContent = this.findDirByContent(claudeDir, workspacePath);
    if (byContent) { log(`Session dir matched by content: ${byContent}`); return byContent; }

    const byName = this.findDirByName(claudeDir, workspacePath);
    if (byName) { log(`Session dir matched by name: ${byName}`); return byName; }

    const fallback = this.mostRecentProjectDir(claudeDir);
    if (fallback) log(`Session dir fallback (most recent): ${fallback}`);
    return fallback;
  }

  private findDirByContent(claudeDir: string, workspacePath: string): string | undefined {
    const normalized = workspacePath.replace(/\\/g, '/').toLowerCase();
    try {
      const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(claudeDir, e.name));

      for (const dirPath of projectDirs) {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(dirPath, f));
        for (const jf of jsonlFiles) {
          if (this.fileContainsCwd(jf, normalized)) return dirPath;
        }
      }
    } catch { /* ignore */ }
    return undefined;
  }

  private fileContainsCwd(filePath: string, normalizedCwd: string): boolean {
    try {
      const buf = Buffer.alloc(8192);
      const fd  = fs.openSync(filePath, 'r');
      const n   = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      for (const line of buf.slice(0, n).toString('utf-8').split('\n').slice(0, 20)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const cwd = (obj['cwd'] as string | undefined)?.replace(/\\/g, '/').toLowerCase();
          if (cwd && (cwd === normalizedCwd || cwd.startsWith(normalizedCwd))) return true;
        } catch { /* malformed line */ }
      }
    } catch { /* unreadable */ }
    return false;
  }

  private findDirByName(claudeDir: string, workspacePath: string): string | undefined {
    const normalized = workspacePath.replace(/\\/g, '/');
    const candidates = new Set<string>([
      normalized.replace(/[^a-zA-Z0-9-]/g, '-'),
      normalized.replace(/\//g, '-'),
    ]);
    for (const c of [...candidates]) candidates.add(c.toLowerCase());

    try {
      for (const { name } of fs.readdirSync(claudeDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
        if (candidates.has(name) || candidates.has(name.toLowerCase())) {
          return path.join(claudeDir, name);
        }
        for (const c of candidates) {
          if (name.endsWith(c) || c.endsWith(name)) return path.join(claudeDir, name);
        }
      }
    } catch { /* ignore */ }
    return undefined;
  }

  private mostRecentProjectDir(claudeDir: string): string | undefined {
    try {
      return fs.readdirSync(claudeDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ dirPath: path.join(claudeDir, e.name), mtime: fs.statSync(path.join(claudeDir, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]?.dirPath;
    } catch { return undefined; }
  }

  private readAllLines(filePath: string): JournalEntry[] {
    return fs.readFileSync(filePath, 'utf-8')
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
