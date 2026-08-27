// Oxlint diagnostics via `oxlint --format json`.

import * as path from 'path';
import { Event, EventEmitter, Uri, workspace, WorkspaceFolder } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProviderCapabilities, ScanProgress, ProblemSeverity } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';
import { OxlintRunner } from './OxlintRunner';
import { OxlintProjectResolver } from './OxlintProjectResolver';

export interface OxlintScanError {
  readonly folder: string;
  readonly message: string;
}

export interface OxlintScanTiming {
  readonly totalMs: number;
  readonly resolveFoldersMs: number;
  readonly oxlintRunsMs: number;
  readonly parseMs: number;
  readonly storeWriteMs: number;
}

export class OxlintDiagnosticProvider implements DiagnosticProvider {
  readonly name = 'oxlint';
  readonly capabilities: ProviderCapabilities = {
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'] as const,
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
  private readonly runner: OxlintRunner;
  private readonly resolver: OxlintProjectResolver;
  private timeoutMs: number;
  private abortController: AbortController | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _refreshResolve: (() => void) | undefined;
  private _lastScanErrors: OxlintScanError[] = [];
  private _lastScanDurationMs = 0;
  private _lastScanTiming: OxlintScanTiming | undefined;
  private _maxConcurrentScans = 2;
  private _lastScanUris = new Set<string>();
  private _resolvedExecutable: string | undefined;
  private _resolvedProjects: { folder: WorkspaceFolder; configPath?: string }[] = [];
  private _initialized = false;
  private readonly _logger: (msg: string) => void;

  get store(): ProblemStore { return this._store; }
  get scanning(): boolean { return this._scanning; }
  get lastScanErrors(): readonly OxlintScanError[] { return this._lastScanErrors; }
  get lastScanDurationMs(): number { return this._lastScanDurationMs; }
  get lastScanTiming(): OxlintScanTiming | undefined { return this._lastScanTiming; }
  get pendingRefresh(): boolean { return this._pendingRefresh; }
  get enabled(): boolean { return this._enabled; }
  get autoScan(): boolean { return true; }

  constructor(
    store: ProblemStore,
    logger?: (msg: string) => void,
    runner?: OxlintRunner,
    resolver?: OxlintProjectResolver,
    timeoutMs?: number,
  ) {
    this._store = store;
    this._logger = logger ?? ((msg) => console.log(msg));
    this.runner = runner ?? new (require('./OxlintRunner').OxlintRunner)();
    this.resolver = resolver ?? new (require('./OxlintProjectResolver').OxlintProjectResolver)();
    this.timeoutMs = timeoutMs ?? 120_000;
  }

  updateConfig(cfg: { enabled: boolean; timeout: number; maxConcurrentScans: number }): void {
    this._enabled = cfg.enabled;
    this.timeoutMs = cfg.timeout;
    this._maxConcurrentScans = cfg.maxConcurrentScans;
  }

  async initialize(): Promise<void> {
    this._logger('[LOG:OXLINT-initialize] CALLED');
    if (this._disposed) { this._logger('[LOG:OXLINT-init] DISPOSED — returning'); return; }
    if (this._initialized) { this._logger('[LOG:OXLINT-init] ALREADY INITIALIZED — returning'); return; }
    this._initialized = true;

    const workspaceFolders = workspace.workspaceFolders ?? [];
    const fromDir = workspaceFolders[0]?.uri.fsPath ?? process.cwd();

    const resolved = await this.resolver.resolveOxlintExecutable(fromDir);

    if (!resolved) {
      this._logger('[LOG:OXLINT-init] Oxlint not available — provider disabled. JS diagnostics via VS Code realtime only.');
      this._enabled = false;
      return;
    }

    this._resolvedExecutable = resolved.path;
    this._logger(`[LOG:OXLINT] Using Oxlint: ${resolved.path} (v${resolved.version})`);

    this._resolvedProjects = await this.resolver.resolveProjects();

    const changed = await this.runScan();
    this._logger(`[LOG:OXLINT-init] runScan returned changed.length=${changed.length}`);
    if (changed.length > 0) {
      this._logger(`[LOG:OXLINT-init] BEFORE _onDidUpdate.fire() — ${changed.length} URIs`);
      this._onDidUpdate.fire(changed);
      this._logger(`[LOG:OXLINT-init] AFTER _onDidUpdate.fire()`);
    } else {
      this._logger(`[LOG:OXLINT-init] changed.length=0 — SKIPPING _onDidUpdate.fire()`);
    }
  }

  start(): void {}
  stop(): void {
    this._clearDebounce();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  async refresh(): Promise<void> {
    this._clearDebounce();
    const changed = await this.runScan();
    if (!this._disposed && changed.length > 0) {
      this._onDidUpdate.fire(changed);
    }
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
    if (this._scanning) {
      this._pendingRefresh = true;
      return [];
    }

    if (!this._enabled || !this._resolvedExecutable) {
      this._logger('[LOG:OXLINT-runScan] Provider disabled or no executable — skipping');
      return [];
    }

    this._scanning = true;
    this._lastScanErrors = [];
    this._pendingRefresh = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const timing = { totalMs: 0, resolveFoldersMs: 0, oxlintRunsMs: 0, parseMs: 0, storeWriteMs: 0 };
    const scanStart = performance.now();

    try {
      if (signal.aborted) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Scan cancelled' });
        return [];
      }

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'resolving', message: 'Resolving Oxlint projects...' });

      if (this._resolvedProjects.length === 0) {
        const msg = 'No workspace folders with JavaScript/TypeScript files found.';
        this._lastScanErrors.push({ folder: '', message: msg });
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: msg });
        return [];
      }

      const allDiagnostics = new Map<string, { filePath: string; line: number | undefined; column: number | undefined; endLine?: number; endColumn?: number; severity: 'error' | 'warning'; message: string; code: string }[]>();

      const oxlintStart = performance.now();
      const semaphore = this.makeSemaphore(this._maxConcurrentScans);

      for (const project of this._resolvedProjects) {
        await semaphore.acquire();
        if (signal.aborted) {
          semaphore.release();
          return [];
        }

        this._onDidProgressScan.fire({ providerName: this.name, phase: 'scanning', message: `Scanning ${project.folder.name}...` });

        const options = {
          cwd: project.folder.uri.fsPath,
          script: this._resolvedExecutable,
          configPath: project.configPath,
          timeoutMs: this.timeoutMs,
        };

        let result;
        try {
          result = await this.runner.run(options);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._lastScanErrors.push({ folder: project.folder.name, message: msg });
          semaphore.release();
          return [];
        }

        if (result.cancelled || result.timedOut) {
          const msg = result.error ?? (result.timedOut ? 'Oxlint timed out' : 'Oxlint cancelled');
          this._lastScanErrors.push({ folder: project.folder.name, message: msg });
          semaphore.release();
          return [];
        }

        if (result.error) {
          this._logger(`[LOG:OXLINT-runScan] Error from oxlint: ${result.error}`);
        }

        this._onDidProgressScan.fire({ providerName: this.name, phase: 'parsing', message: `Parsing ${project.folder.name} output...` });

        for (const diag of result.diagnostics) {
          // oxlint reports cwd-relative paths when scanning without an explicit
          // target. Convert to absolute so Uri.file() produces a key that
          // matches VS Code's canonical workspace URIs.
          const absPath = path.isAbsolute(diag.filePath)
            ? diag.filePath
            : path.resolve(project.folder.uri.fsPath, diag.filePath);
          const existing = allDiagnostics.get(absPath);
          if (existing) {
            existing.push(diag);
          } else {
            allDiagnostics.set(absPath, [{ ...diag, filePath: absPath }]);
          }
        }
        semaphore.release();
      }

      timing.oxlintRunsMs = performance.now() - oxlintStart;

      this.abortController = undefined;

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'writing', message: 'Writing results to store...' });

      const writeStart = performance.now();
      const changed = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;

      timing.totalMs = performance.now() - scanStart;
      this._lastScanDurationMs = timing.totalMs;
      this._lastScanTiming = timing;

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: `Completed in ${timing.totalMs.toFixed(0)}ms` });

      return changed;
    } finally {
      this._scanning = false;
      while (this._pendingRefresh) {
        this._pendingRefresh = false;
        const changed = await this.runScan();
        if (!this._disposed && changed.length > 0) {
          this._onDidUpdate.fire(changed);
        }
      }
      if (this._disposed) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Provider disposed' });
      }
    }
  }

  private writeToStore(diagnostics: Map<string, { filePath: string; line: number | undefined; column: number | undefined; endLine?: number; endColumn?: number; severity: 'error' | 'warning'; message: string; code: string }[]>): Uri[] {
    const changed: Uri[] = [];
    const scannedUris = new Set<string>();

    for (const [filePath, fileDiags] of diagnostics) {
      // Safety net: never surface badges for vendored/SCM-internal files even
      // if a loose oxlint config or invoked path made oxlint lint them.
      if (/[\\/]node_modules[\\/]|[\\/]\.git[\\/]/.test(filePath)) {
        continue;
      }
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.file(filePath);
      const key = normalizeUriKey(uri);
      scannedUris.add(key);
      const result = this._store.set(uri, state, 'oxlint');
      if (result) {
        changed.push(uri);
      }
    }

    const CLEAN_STATE = {
      severity: ProblemSeverity.None,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      fileCount: 0,
    };
    for (const key of this._lastScanUris) {
      if (!scannedUris.has(key)) {
        const uri = Uri.parse(key);
        if (this._store.set(uri, CLEAN_STATE, 'oxlint')) {
          changed.push(uri);
        }
      }
    }

    this._lastScanUris = scannedUris;
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

  private aggregateFileState(diagnostics: { filePath: string; line: number | undefined; column: number | undefined; endLine?: number; endColumn?: number; severity: 'error' | 'warning'; message: string; code: string }[]): { severity: number; errorCount: number; warningCount: number; infoCount: number; fileCount: number } {
    let errorCount = 0, warningCount = 0;

    for (const diag of diagnostics) {
      if (diag.severity === 'error') errorCount++;
      else if (diag.severity === 'warning') warningCount++;
    }

    let severity = ProblemSeverity.None;
    if (errorCount > 0) severity = ProblemSeverity.Error;
    else if (warningCount > 0) severity = ProblemSeverity.Warning;

    return { severity, errorCount, warningCount, infoCount: 0, fileCount: errorCount > 0 || warningCount > 0 ? 1 : 0 };
  }
}