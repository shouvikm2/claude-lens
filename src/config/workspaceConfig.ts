import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ClensConfigSchema, type ClensConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { log, logError } from '../utils/logger.js';

const CONFIG_FILENAME = '.claudelens';

export class WorkspaceConfig {
  private config: ClensConfig = DEFAULT_CONFIG;
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<ClensConfig>();

  readonly onDidChange = this.changeEmitter.event;

  async load(): Promise<ClensConfig> {
    const configPath = this.resolveConfigPath();
    if (!configPath) {
      log('.claudelens not found — using defaults');
      this.config = DEFAULT_CONFIG;
      this.notifyMissing();
      return this.config;
    }
    await this.readAndParse(configPath);
    this.startWatcher();
    return this.config;
  }

  get(): ClensConfig {
    return this.config;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.changeEmitter.dispose();
  }

  private resolveConfigPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    const candidate = path.join(folders[0].uri.fsPath, CONFIG_FILENAME);
    return fs.existsSync(candidate) ? candidate : undefined;
  }

  private async readAndParse(filePath: string): Promise<void> {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const json: unknown = JSON.parse(raw);
      const result = ClensConfigSchema.safeParse(json);
      if (result.success) {
        this.config = result.data;
        log(`.claudelens loaded — project: "${this.config.project}"`);
      } else {
        logError('.claudelens validation failed', result.error.message);
        this.config = DEFAULT_CONFIG;
        vscode.window.showWarningMessage(
          '⬡ Claude Lens: .claudelens has invalid fields — falling back to defaults.'
        );
      }
    } catch (err) {
      logError('Failed to parse .claudelens', err);
      this.config = DEFAULT_CONFIG;
    }
  }

  private startWatcher(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folders[0], CONFIG_FILENAME)
    );

    this.watcher.onDidChange(async () => {
      log('.claudelens changed — reloading');
      const configPath = this.resolveConfigPath();
      if (configPath) {
        await this.readAndParse(configPath);
        this.changeEmitter.fire(this.config);
      }
    });

    this.watcher.onDidCreate(async (uri) => {
      log('.claudelens created');
      await this.readAndParse(uri.fsPath);
      this.changeEmitter.fire(this.config);
    });

    this.watcher.onDidDelete(() => {
      log('.claudelens deleted — reverting to defaults');
      this.config = DEFAULT_CONFIG;
      this.changeEmitter.fire(this.config);
    });
  }

  private notifyMissing(): void {
    vscode.window
      .showInformationMessage(
        '⬡ Claude Lens: No .claudelens config found. Add one to enable budget caps.',
        'Create Config',
        'Dismiss'
      )
      .then(choice => {
        if (choice === 'Create Config') {
          vscode.commands.executeCommand('claudeLens.createConfig');
        }
      });
  }
}
