import { Event, EventEmitter, Uri, WorkspaceFolder, workspace } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { DiagnosticProviderManager } from './DiagnosticProviderManager';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity, EslintConfig, ProviderCapabilities, ScanProgress } from '../core/types';
import { EslintRunner, EslintRunOptions, EslintDiagnostic } from '../typescript/EslintRunner';
import { chainCounters } from '../forensicLogger';
import { debugLog } from '../core/debug';
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
  readonly capabilities: ProviderCapabilities = {
    extensions: ['.js', '.jsx', '.vue', '.svelte'],
    realtime: false,
    manualScan: true,
    startupScan: true,
    fullWorkspace: true,
  };
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  private readonly _onDidProgressScan = new EventEmitter<ScanProgress>();
  readonly onDidProgressScan: Event<ScanProgress> = this._onDidProgressScan.event;
  private _disposed = false;
  private _scanning = false;
  private _pendingRefresh = false;
  private _enabled = true;
  private readonly runner: EslintRunner;
  private timeoutMs: number;
  private readonly refreshDebounceMs: number;
  private abortController: AbortController | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _refreshResolve: (() => void) | undefined;
  private _lastScanErrors: EslintScanError[] = [];
  private _lastScanDurationMs = 0;
  private _lastScanTiming: EslintScanTiming | undefined;
  private _maxConcurrentScans = 2;
  private _cachedFolders: { folders: WorkspaceFolder[]; timestamp: number } | undefined;
  private _folderCacheTtlMs = 60_000;
  private readonly _manager: DiagnosticProviderManager | undefined;

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
    return true;
  }

  constructor(
    store: ProblemStore,
    manager?: DiagnosticProviderManager,
    runner?: EslintRunner,
    timeoutMs?: number,
    refreshDebounceMs?: number,
  ) {
    this._store = store;
    this._manager = manager;
    this.runner = runner ?? new EslintRunner();
    this.timeoutMs = timeoutMs ?? 120_000;
    this.refreshDebounceMs = refreshDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  updateConfig(cfg: EslintConfig): void {
    this._enabled = cfg.enabled;
    this.timeoutMs = cfg.timeout;
    this._maxConcurrentScans = cfg.maxConcurrentScans;
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
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] ESLINT.refresh() ENTER name=${this.name} _enabled=${this._enabled} _disposed=${this._disposed} _scanning=${this._scanning} _pendingRefresh=${this._pendingRefresh}`);
    chainCounters.providerRefreshCalled++;
    if (this._disposed) { debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() EARLY RETURN — disposed`); return; }
    if (!this._enabled) { debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() EARLY RETURN — disabled`); return; }

    this._clearDebounce();
    debugLog(`[AUDIT:${ts}] ESLINT.refresh() debounce cleared, setting ${this.refreshDebounceMs}ms timer`);

    return new Promise<void>((resolve) => {
      this._refreshResolve = resolve;
      this._debounceTimer = setTimeout(async () => {
        this._refreshResolve = undefined;
        const fireTs = Date.now();
        debugLog(`[AUDIT:${fireTs}] ESLINT.refresh() debounce FIRED (waited ${fireTs - ts}ms)`);
        this._debounceTimer = undefined;
        try {
          const changed = await this.runScan();
          debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() runScan returned changed.length=${changed.length} changed=[${changed.map(u => u.fsPath).join(', ')}]`);
          if (!this._disposed && changed.length > 0) {
            chainCounters.providerRunScanReturned++;
            debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() firing _onDidUpdate with ${changed.length} URIs`);
            this._onDidUpdate.fire(changed);
            chainCounters.providerOnDidUpdateFired++;
            debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() _onDidUpdate fired`);
          } else {
            debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() SKIP _onDidUpdate — changed.length=${changed.length} _disposed=${this._disposed}`);
          }
        } catch (err) {
          debugLog(`[AUDIT:${Date.now()}] ESLINT.refresh() runScan THREW: ${err instanceof Error ? err.message : String(err)}`);
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
    this._onDidProgressScan.dispose();
  }

  releaseOwnership(): void {
    this._store.releaseOwnership(this.name);
  }

  private _clearDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
    if (this._refreshResolve) {
      this._refreshResolve();
      this._refreshResolve = undefined;
    }
  }

  async runScan(): Promise<Uri[]> {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] ESLINT.runScan() ENTER _disposed=${this._disposed} _enabled=${this._enabled} _scanning=${this._scanning}`);
    if (this._disposed) { debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — disposed`); return []; }
    if (!this._enabled) { debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — disabled`); return []; }
    if (this._scanning) {
      this._pendingRefresh = true;
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — already scanning, _pendingRefresh set to true`);
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
      if (signal.aborted) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Scan cancelled' });
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — signal aborted before resolve`);
        return [];
      }

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'resolving', message: 'Resolving ESLint projects...' });

      const workspaceFolders = this.getWorkspaceFolders();
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() workspaceFolders=${workspaceFolders.length}`);
      if (workspaceFolders.length === 0) {
        const msg = 'No workspace folders open.';
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — ${msg}`);
        this._lastScanErrors.push({ folder: '', message: msg });
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: msg });
        return [];
      }

      const allDiagnostics = new Map<string, EslintDiagnostic[]>();

      const resolveStart = performance.now();
      const foldersWithEslint = await this.findFoldersWithEslint(workspaceFolders);
      timing.resolveFoldersMs = performance.now() - resolveStart;
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() findFoldersWithEslint returned ${foldersWithEslint.length} folders in ${timing.resolveFoldersMs.toFixed(0)}ms`);
      if (signal.aborted) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Scan cancelled' });
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — signal aborted after resolve`);
        return [];
      }

      for (const f of workspaceFolders) {
        const hasEslint = foldersWithEslint.some(ef => ef.uri.toString() === f.uri.toString());
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() folder "${f.name}" hasEslint=${hasEslint}`);
      }

      if (foldersWithEslint.length === 0) {
        const msg = 'No ESLint configuration found in any workspace folder.';
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() EARLY RETURN — ${msg}`);
        this._lastScanErrors.push({ folder: '', message: msg });
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: msg });
        return [];
      }

      const eslintStart = performance.now();
      const ownedExts = this._manager?.getOwnedExtensions(this.name) ?? this.capabilities.extensions;
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() ownedExts=[${ownedExts.join(',')}]`);
      const semaphore = this.makeSemaphore(this._maxConcurrentScans);
      let totalDiagsParsed = 0;
      await Promise.all(foldersWithEslint.map(async (folder) => {
        await semaphore.acquire();
        if (signal.aborted) {
          semaphore.release();
          return;
        }

        this._onDidProgressScan.fire({ providerName: this.name, phase: 'scanning', message: `Scanning ${folder.name}...` });

        const runnerStart = performance.now();
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() Running eslint in folder=${folder.uri.fsPath}`);
        const options: EslintRunOptions = {
          cwd: folder.uri.fsPath,
          ext: [...ownedExts],
          signal,
          timeoutMs: this.timeoutMs,
        };

        let result;
        try {
          result = await this.runner.run(options);
          debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() runner.run() completed in ${(performance.now() - runnerStart).toFixed(0)}ms exitCode=${result.exitCode} cancelled=${result.cancelled} timedOut=${result.timedOut} stdout=${result.stdout.length}chars`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() runner.run() THREW: ${msg}`);
          this._lastScanErrors.push({ folder: folder.name, message: msg });
          semaphore.release();
          return;
        }

        if (result.cancelled || result.timedOut) {
          const msg = result.error ?? (result.timedOut ? 'ESLint timed out' : 'ESLint cancelled');
          debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() SKIP — ${msg}`);
          this._lastScanErrors.push({ folder: folder.name, message: msg });
          semaphore.release();
          return;
        }

        if (result.error) {
          debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() runner returned error=${result.error}`);
        }

        this._onDidProgressScan.fire({ providerName: this.name, phase: 'parsing', message: `Parsing ${folder.name} output...` });

        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() "${folder.name}" output: ${result.stdout.length} chars`);

        const parseStart = performance.now();
        const diagnostics = this.runner.parseOutput(result.stdout);
        const parseMs = performance.now() - parseStart;
        timing.parseMs += parseMs;
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() runner.parseOutput() returned ${diagnostics.length} diagnostics in ${parseMs.toFixed(0)}ms`);

        const fileCount = new Set<string>();
        for (const diag of diagnostics) {
          const key = diag.uri.toString();
          fileCount.add(key);
          const existing = allDiagnostics.get(key);
          if (existing) {
            existing.push(diag);
          } else {
            allDiagnostics.set(key, [diag]);
          }
        }
        totalDiagsParsed += diagnostics.length;
        debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() aggregated ${diagnostics.length} diags across ${fileCount.size} files for folder=${folder.name}`);
        semaphore.release();
      }));
      timing.eslintRunsMs = performance.now() - eslintStart;
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() all folders done in ${timing.eslintRunsMs.toFixed(0)}ms total parsed=${totalDiagsParsed} total files=${allDiagnostics.size}`);

      this.abortController = undefined;

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'writing', message: 'Writing results to store...' });

      const writeStart = performance.now();
      const changed = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() writeToStore returned ${changed.length} changed URIs in ${timing.storeWriteMs.toFixed(0)}ms`);

      timing.totalMs = performance.now() - scanStart;
      this._lastScanDurationMs = timing.totalMs;
      this._lastScanTiming = timing;

      if (changed.length === 0 && this._lastScanErrors.length > 0) {
        for (const e of this._lastScanErrors) {
          debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() error: ${e.folder || '(workspace)'} — ${e.message}`);
        }
      }

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: `Completed in ${timing.totalMs.toFixed(0)}ms` });
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() RETURN ${changed.length} changed URIs (totalMs=${timing.totalMs.toFixed(0)}ms)`);

      return changed;
    } finally {
      this._scanning = false;
      debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() finally _scanning=false _pendingRefresh=${this._pendingRefresh}`);
      while (this._pendingRefresh) {
        this._pendingRefresh = false;
        const changed = await this.runScan();
        if (!this._disposed && changed.length > 0) {
          debugLog(`[AUDIT:${Date.now()}] ESLINT.runScan() pending refresh completed: ${changed.length} URIs`);
          this._onDidUpdate.fire(changed);
        }
      }
      if (this._disposed) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Provider disposed' });
      }
    }
  }

  private getWorkspaceFolders(): readonly WorkspaceFolder[] {
    return workspace.workspaceFolders ?? [];
  }

  private async findFoldersWithEslint(folders: readonly WorkspaceFolder[]): Promise<WorkspaceFolder[]> {
    if (this._cachedFolders && Date.now() - this._cachedFolders.timestamp < this._folderCacheTtlMs) {
      return this._cachedFolders.folders;
    }
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

    this._cachedFolders = { folders: result, timestamp: Date.now() };
    return result;
  }

  private writeToStore(diagnostics: Map<string, EslintDiagnostic[]>): Uri[] {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] ESLINT.writeToStore() ENTER diagFiles=${diagnostics.size} provider="${this.name}"`);
    const changed: Uri[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const [uriString, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.parse(uriString);
      const result = this._store.set(uri, state, this.name);
      debugLog(`[AUDIT:${Date.now()}] ESLINT.writeToStore() uri="${uriString}" diags=${fileDiags.length} severity=${state.severity} errors=${state.errorCount} warnings=${state.warningCount} store.set()=${result}`);
      if (result) {
        changed.push(uri);
        accepted++;
      } else {
        rejected++;
      }
    }

    debugLog(`[AUDIT:${Date.now()}] ESLINT.writeToStore() RETURN accepted=${accepted} rejected=${rejected} changed=${changed.length}`);
    return changed;
  }

  private makeSemaphore(concurrency: number): { acquire: () => Promise<void>; release: () => void } {
    if (concurrency <= 1) return { acquire: () => Promise.resolve(), release: () => {} };
    let running = 0;
    const queue: (() => void)[] = [];
    const acquire = () => new Promise<void>((resolve) => {
      running++;
      if (running <= concurrency) { resolve(); return; }
      queue.push(resolve);
    });
    const release = () => {
      running--;
      if (queue.length > 0) { running++; const next = queue.shift()!; next(); }
    };
    return { acquire, release };
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