import { Event, EventEmitter, Uri, WorkspaceFolder, workspace } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity, EslintConfig } from '../core/types';
import { EslintRunner, EslintRunOptions, EslintDiagnostic } from '../typescript/EslintRunner';
import { chainCounters } from '../forensicLogger';
import * as path from 'path';

export interface EslintScanContext {
  readonly workspaceFolders: WorkspaceFolder[];
  readonly diagnostics: Map<string, EslintDiagnostic[]>;
}

export interface EslintScanError {
  readonly folder: string;
  readonly message: string;
}

export interface EslintScanTiming {
  readonly totalMs: number;
  readonly resolveFoldersMs: number;
  readonly eslintRunsMs: number;
  readonly parseMs: number;
  readonly storeWriteMs: number;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

const DEFAULT_DEBOUNCE_MS = 300;

export class EslintDiagnosticProvider implements DiagnosticProvider {
  readonly name = 'eslint';
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  private _disposed = false;
  private _scanning = false;
  private _pendingRefresh = false;
  private _enabled = true;
  private _autoScan = true;
  private readonly runner: EslintRunner;
  private timeoutMs: number;
  private readonly refreshDebounceMs: number;
  private abortController: AbortController | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastScanErrors: EslintScanError[] = [];
  private _lastScanDurationMs = 0;
  private _lastScanTiming: EslintScanTiming | undefined;

  get store(): ProblemStore {
    return this._store;
  }

  get scanning(): boolean {
    return this._scanning;
  }

  get lastScanErrors(): readonly EslintScanError[] {
    return this._lastScanErrors;
  }

  get lastScanDurationMs(): number {
    return this._lastScanDurationMs;
  }

  get lastScanTiming(): EslintScanTiming | undefined {
    return this._lastScanTiming;
  }

  get pendingRefresh(): boolean {
    return this._pendingRefresh;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get autoScan(): boolean {
    return this._autoScan;
  }

  constructor(
    store: ProblemStore,
    runner?: EslintRunner,
    timeoutMs?: number,
    refreshDebounceMs?: number,
  ) {
    this._store = store;
    this.runner = runner ?? new EslintRunner();
    this.timeoutMs = timeoutMs ?? 120_000;
    this.refreshDebounceMs = refreshDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  updateConfig(cfg: EslintConfig): void {
    this._enabled = cfg.enabled;
    this._autoScan = cfg.autoScan;
    this.timeoutMs = cfg.timeout;
  }

  async initialize(): Promise<void> {
    if (this._disposed) { console.log('[LOG:ESLINT-init] DISPOSED — returning'); return; }
    const changed = await this.runScan();
    console.log(`[LOG:ESLINT-init] runScan returned changed.length=${changed.length}`);
    if (changed.length > 0) {
      chainCounters.providerRunScanReturned++;
      console.log(`[LOG:ESLINT-init] BEFORE _onDidUpdate.fire() — ${changed.length} URIs`);
      this._onDidUpdate.fire(changed);
      chainCounters.providerOnDidUpdateFired++;
      console.log(`[LOG:ESLINT-init] AFTER _onDidUpdate.fire()`);
    } else {
      console.log(`[LOG:ESLINT-init] changed.length=0 → SKIPPING _onDidUpdate.fire()`);
    }
  }

  start(): void {
    // ESLint runs on-demand via refresh()
  }

  stop(): void {
    this._clearDebounce();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  async refresh(): Promise<void> {
    chainCounters.providerRefreshCalled++;
    if (this._disposed) { console.log('[LOG:ESLINT-refresh] DISPOSED — returning'); return; }
    if (!this._enabled) { console.log('[LOG:ESLINT-refresh] DISABLED — returning'); return; }

    this._clearDebounce();

    return new Promise<void>((resolve) => {
      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = undefined;
        const changed = await this.runScan();
        console.log(`[LOG:ESLINT-refresh] runScan returned changed.length=${changed.length}`);
        if (!this._disposed && changed.length > 0) {
          chainCounters.providerRunScanReturned++;
          console.log(`[LOG:ESLINT-refresh] BEFORE _onDidUpdate.fire() — ${changed.length} URIs`);
          this._onDidUpdate.fire(changed);
          chainCounters.providerOnDidUpdateFired++;
          console.log(`[LOG:ESLINT-refresh] AFTER _onDidUpdate.fire()`);
        } else {
          console.log(`[LOG:ESLINT-refresh] changed.length=0 OR disposed → SKIPPING _onDidUpdate.fire()`);
        }
        resolve();
      }, this.refreshDebounceMs);
    });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._onDidUpdate.dispose();
  }

  releaseOwnership(): void {
    this._store.releaseOwnership(this.name);
  }

  private _clearDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
  }

  async runScan(): Promise<Uri[]> {
    if (this._disposed) return [];
    if (!this._enabled) return [];
    if (this._scanning) {
      this._pendingRefresh = true;
      return [];
    }

    this._scanning = true;
    this._lastScanErrors = [];
    this._pendingRefresh = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const timing: Mutable<EslintScanTiming> = {
      totalMs: 0,
      resolveFoldersMs: 0,
      eslintRunsMs: 0,
      parseMs: 0,
      storeWriteMs: 0,
    };
    const scanStart = performance.now();

    try {
      if (signal.aborted) return [];

      const workspaceFolders = this.getWorkspaceFolders();
      if (workspaceFolders.length === 0) {
        this._lastScanErrors.push({
          folder: '',
          message: 'No workspace folders open.',
        });
        return [];
      }

      const allDiagnostics = new Map<string, EslintDiagnostic[]>();

      const resolveStart = performance.now();
      const foldersWithEslint = await this.findFoldersWithEslint(workspaceFolders);
      timing.resolveFoldersMs = performance.now() - resolveStart;
      if (signal.aborted) return [];

      if (foldersWithEslint.length === 0) {
        this._lastScanErrors.push({
          folder: '',
          message: 'No ESLint configuration found in any workspace folder.',
        });
        return [];
      }

      const eslintStart = performance.now();
      for (const folder of foldersWithEslint) {
        if (signal.aborted) break;

        const options: EslintRunOptions = {
          cwd: folder.uri.fsPath,
          signal,
          timeoutMs: this.timeoutMs,
        };

        let result;
        try {
          result = await this.runner.run(options);
        } catch (err) {
          this._lastScanErrors.push({
            folder: folder.name,
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        if (result.cancelled || result.timedOut) {
          this._lastScanErrors.push({
            folder: folder.name,
            message: result.error ?? (result.timedOut ? 'ESLint timed out' : 'ESLint cancelled'),
          });
          continue;
        }

        const parseStart = performance.now();
        const diagnostics = this.runner.parseOutput(result.stdout);
        timing.parseMs += performance.now() - parseStart;

        for (const diag of diagnostics) {
          const key = diag.uri.toString();
          const existing = allDiagnostics.get(key);
          if (existing) {
            existing.push(diag);
          } else {
            allDiagnostics.set(key, [diag]);
          }
        }
      }
      timing.eslintRunsMs = performance.now() - eslintStart;

      this.abortController = undefined;

      const writeStart = performance.now();
      const changed = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;

      timing.totalMs = performance.now() - scanStart;
      this._lastScanDurationMs = timing.totalMs;
      this._lastScanTiming = timing;

      if (changed.length === 0 && this._lastScanErrors.length > 0) {
        for (const e of this._lastScanErrors) {
          console.log(`[LOG:ESLINT-error] ${e.folder || '(workspace)'} — ${e.message}`);
        }
      }

      return changed;
    } finally {
      this._scanning = false;
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        const changed = await this.runScan();
        if (!this._disposed && changed.length > 0) {
          this._onDidUpdate.fire(changed);
        }
      }
    }
  }

  private getWorkspaceFolders(): readonly WorkspaceFolder[] {
    return workspace.workspaceFolders ?? [];
  }

  private async findFoldersWithEslint(folders: readonly WorkspaceFolder[]): Promise<WorkspaceFolder[]> {
    const fs = await import('fs/promises');
    const result: WorkspaceFolder[] = [];

    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;
      const configFiles = [
        '.eslintrc.js',
        '.eslintrc.cjs',
        '.eslintrc.yaml',
        '.eslintrc.yml',
        '.eslintrc.json',
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.ts',
      ];

      let hasConfig = false;
      for (const config of configFiles) {
        try {
          await fs.access(path.join(folderPath, config));
          hasConfig = true;
          break;
        } catch {
          // not found
        }
      }

      // Also check package.json for eslintConfig
      if (!hasConfig) {
        try {
          const pkgPath = path.join(folderPath, 'package.json');
          const pkgContent = await fs.readFile(pkgPath, 'utf8');
          const pkg = JSON.parse(pkgContent);
          if (pkg.eslintConfig) {
            hasConfig = true;
          }
        } catch {
          // no package.json or no eslintConfig
        }
      }

      if (hasConfig) {
        result.push(folder);
      }
    }

    return result;
  }

  private writeToStore(diagnostics: Map<string, EslintDiagnostic[]>): Uri[] {
    const changed: Uri[] = [];

    for (const [uriString, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.parse(uriString);
      this._store.set(uri, state, this.name);
      changed.push(uri);
    }

    return changed;
  }

  private aggregateFileState(diagnostics: EslintDiagnostic[]): ProblemState {
    let errorCount = 0;
    let warningCount = 0;

    for (const diag of diagnostics) {
      if (diag.severity === ProblemSeverity.Error) {
        errorCount++;
      } else if (diag.severity === ProblemSeverity.Warning) {
        warningCount++;
      }
    }

    let severity = ProblemSeverity.None;
    if (errorCount > 0) severity = ProblemSeverity.Error;
    else if (warningCount > 0) severity = ProblemSeverity.Warning;

    return {
      severity,
      errorCount,
      warningCount,
      infoCount: 0,
      fileCount: errorCount > 0 || warningCount > 0 ? 1 : 0,
    };
  }

  getMemoryUsage(): NodeJS.MemoryUsage | undefined {
    try {
      return process.memoryUsage();
    } catch {
      return undefined;
    }
  }
}