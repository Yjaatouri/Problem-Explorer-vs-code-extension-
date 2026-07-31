import { Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity, TscConfig, ProviderCapabilities, ScanProgress } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';
import { ProjectResolver, TypeScriptProject } from '../typescript/ProjectResolver';
import { TscRunner, TscRunOptions, DEFAULT_TSC_TIMEOUT_MS } from '../typescript/TscRunner';
import { TscOutputParser, TscDiagnostic } from '../typescript/TscOutputParser';
import * as path from 'path';

export interface TscScanContext {
  readonly projects: TypeScriptProject[];
  readonly diagnostics: Map<string, TscDiagnostic[]>;
}

export interface TscScanError {
  readonly tsconfigPath: string;
  readonly message: string;
}

export interface ScanTiming {
  readonly totalMs: number;
  readonly resolveProjectsMs: number;
  readonly tscRunsMs: number;
  readonly parseMs: number;
  readonly storeWriteMs: number;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

const DEFAULT_DEBOUNCE_MS = 300;

export class TscDiagnosticProvider implements DiagnosticProvider {
  readonly name = 'tsc';
  readonly capabilities: ProviderCapabilities = {
    extensions: ['.ts', '.tsx'],
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
  private readonly projectResolver: ProjectResolver;
  private readonly tscRunner: TscRunner;
  private readonly outputParser: TscOutputParser;
  private timeoutMs: number;
  private readonly refreshDebounceMs: number;
  private readonly _log: (msg: string) => void;
  private abortController: AbortController | undefined;
  private _lastScanErrors: TscScanError[] = [];
  private _lastScanDurationMs = 0;
  private _lastScanTiming: ScanTiming | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _refreshResolve: (() => void) | undefined;
  private _currentProject: string | undefined;
  private _maxConcurrentScans = 1;
  private _lastScanUris = new Set<string>();

  get store(): ProblemStore {
    return this._store;
  }

  get scanning(): boolean {
    return this._scanning;
  }

  get lastScanErrors(): readonly TscScanError[] {
    return this._lastScanErrors;
  }

  get lastScanDurationMs(): number {
    return this._lastScanDurationMs;
  }

  get lastScanTiming(): ScanTiming | undefined {
    return this._lastScanTiming;
  }

  get pendingRefresh(): boolean {
    return this._pendingRefresh;
  }

  get currentProject(): string | undefined {
    return this._currentProject;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get autoScan(): boolean {
    return true;
  }

  updateConfig(cfg: TscConfig): void {
    const wasEnabled = this._enabled;
    this._enabled = cfg.enabled;
    this.timeoutMs = cfg.timeout;
    this._maxConcurrentScans = cfg.maxConcurrentScans;
    this.projectResolver.useWorkspaceVersion = cfg.useWorkspaceVersion;
    // On disable, release ownership of all URIs this provider previously claimed
    // so vscodeDiagnostics (priority 5) can take over without a window reload.
    if (wasEnabled && !cfg.enabled) {
      this._store.releaseOwnership(this.name);
      this._lastScanUris.clear();
    }
  }

  constructor(
    store: ProblemStore,
    options?: {
      projectResolver?: ProjectResolver;
      tscRunner?: TscRunner;
      outputParser?: TscOutputParser;
      timeoutMs?: number;
      refreshDebounceMs?: number;
      log?: (msg: string) => void;
    },
  ) {
    this._store = store;
    this._log = options?.log ?? (() => {});
    this.projectResolver = options?.projectResolver ?? new ProjectResolver();
    this.tscRunner = options?.tscRunner ?? new TscRunner();
    this.outputParser = options?.outputParser ?? new TscOutputParser();
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TSC_TIMEOUT_MS;
    this.refreshDebounceMs = options?.refreshDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async initialize(): Promise<void> {
    if (this._disposed || !this._enabled) { return; }
    const changed = await this.runScan();
    this._log?.(`[TSC] initialize: runScan returned ${changed.length} changed URIs`);
    if (changed.length > 0) {
      this._onDidUpdate.fire(changed);
    }
  }

  start(): void {
  }

  stop(): void {
    this._clearDebounce();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (this._disposed || !this._enabled) { return; }
    this._clearDebounce();

    return new Promise<void>((resolve) => {
      this._refreshResolve = resolve;
      this._debounceTimer = setTimeout(async () => {
        this._refreshResolve = undefined;
        this._debounceTimer = undefined;
        try {
          const changed = await this.runScan();
          if (changed.length > 0 && !this._disposed) {
            this._onDidUpdate.fire(changed);
          }
        } catch {
        }
        resolve();
      }, this.refreshDebounceMs);
    });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._store.unconfigureProvider(this.name);
    this._onDidUpdate.dispose();
    this._onDidProgressScan.dispose();
  }

  releaseOwnership(): void {
    this._store.releaseOwnership(this.name);
  }

  /** Incremental scan of specific files.
   *
   *  NOTE: True incremental tsc invocation (passing individual files) is not
   *  supported — `tsc -p tsconfig.json file1.ts file2.ts` is rejected by tsc
   *  with TS5042 "Option 'project' cannot be mixed with input files".
   *  Instead, we trigger a full project scan via `runScan()` and let it
   *  write the results back. The `uris` argument is kept for API compat
   *  and for any future incremental-on-files support.
   */
  async refreshUris(uris: readonly Uri[]): Promise<void> {
    this._log?.(`[TSC] refreshUris called with ${uris.length} uris — delegating to runScan`);
    if (!this._enabled || this._disposed || uris.length === 0) { return; }
    if (this._scanning) {
      // Defer to the in-flight scan's pendingRefresh
      this._pendingRefresh = true;
      this._log?.('[TSC] refreshUris: already scanning — pendingRefresh=true');
      return;
    }
    const changed = await this.runScan();
    if (!this._disposed && changed.length > 0) {
      this._onDidUpdate.fire(changed);
    }
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
    this._log?.('[TSC] runScan start');
    if (!this._enabled || this._disposed) { 
      this._log?.('[TSC] runScan exit: disabled or disposed');
      return []; 
    }
    if (this._scanning) {
      this._pendingRefresh = true;
      this._log?.('[TSC] runScan exit: already scanning, pendingRefresh=true');
      return [];
    }

    this._scanning = true;
    this._lastScanErrors = [];
    this._pendingRefresh = false;
    this._currentProject = undefined;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const allDiagnostics = new Map<string, TscDiagnostic[]>();
    const timing: Mutable<ScanTiming> = { totalMs: 0, resolveProjectsMs: 0, tscRunsMs: 0, parseMs: 0, storeWriteMs: 0 };
    const scanStart = performance.now();

    try {
      if (signal.aborted) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Scan cancelled' });
        return [];
      }

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'resolving', message: 'Resolving TypeScript projects...' });

      const resolveStart = performance.now();
      const projects = await this.projectResolver.resolveAll();
      timing.resolveProjectsMs = performance.now() - resolveStart;
      if (signal.aborted) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Scan cancelled' });
        return [];
      }

      if (projects.length === 0) {
        const msg = 'No tsconfig.json found or TypeScript not available in workspace.';
        this._lastScanErrors.push({ tsconfigPath: '', message: msg });
        this._log?.(`[TSC] runScan: ${msg}`);
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: msg });
        return [];
      }

      this._log?.(`[TSC] runScan: ${projects.length} tsconfig projects found`);
      const tscStart = performance.now();
      const semaphore = this.makeSemaphore(this._maxConcurrentScans);
      await Promise.all(projects.map(async (project) => {
        await semaphore.acquire();
        if (signal.aborted) {
          semaphore.release();
          return;
        }

        const projectLabel = path.basename(project.projectRoot);
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'scanning', message: `Scanning ${projectLabel}...`, detail: project.tsconfigPath });

        this._currentProject = project.projectRoot;

        const options: TscRunOptions = {
          typescriptPath: project.typescriptPath,
          tsconfigPath: project.tsconfigPath,
          signal,
          timeoutMs: this.timeoutMs,
        };

        let result;
        try {
          result = await this.tscRunner.run(options);
        } catch (err: unknown) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: err instanceof Error ? err.message : String(err),
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.cancelled) {
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.timedOut) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.error ?? 'Timed out',
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.error) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.error,
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.exitCode !== 0 && this.isConfigError(result)) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.stderr || result.stdout || `tsc exited with code ${result.exitCode}`,
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        this._onDidProgressScan.fire({ providerName: this.name, phase: 'parsing', message: `Parsing ${projectLabel} output...` });

        const combined = result.stderr + '\n' + result.stdout;
        const parseStart = performance.now();
        const parsed = this.outputParser.parse(combined);
        const parseMs = performance.now() - parseStart;
        timing.parseMs += parseMs;

        const fileCount = new Set<string>();
        for (const diag of parsed) {
          const fileKey = path.resolve(project.projectRoot, diag.file);
          fileCount.add(fileKey);
          const existing = allDiagnostics.get(fileKey);
          if (existing) {
            existing.push(diag);
          } else {
            allDiagnostics.set(fileKey, [diag]);
          }
        }

        this._currentProject = undefined;
        semaphore.release();
      }));
      timing.tscRunsMs = performance.now() - tscStart;

      this.abortController = undefined;

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'writing', message: 'Writing results to store...' });

      const writeStart = performance.now();
      this._log?.(`[TSC] runScan: tsc done. ${allDiagnostics.size} files with diagnostics; exitCodes seen`);
      const result = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;
      this._log?.(`[TSC] runScan: writeToStore returned ${result.length} changed URIs`);

      timing.totalMs = performance.now() - scanStart;
      this._lastScanDurationMs = timing.totalMs;
      this._lastScanTiming = timing;

      

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: `Completed in ${timing.totalMs.toFixed(0)}ms` });

      return result;
    } finally {
      this._scanning = false;
      this._currentProject = undefined;
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

  getMemoryUsage(): NodeJS.MemoryUsage | undefined {
    try {
      // process.memoryUsage() is not available in VS Code extension host
      return undefined;
    } catch {
      return undefined;
    }
  }

  private isConfigError(result: { exitCode: number | null; stdout: string; stderr: string }): boolean {
    const combined = (result.stderr + result.stdout).toLowerCase();
    return (
      combined.includes('cannot find') ||
      /\bparse\b/.test(combined) ||
      combined.includes('error reading') ||
      combined.includes('unknown option') ||
      combined.includes('cannot execute')
    );
  }

  private writeToStore(diagnostics: Map<string, TscDiagnostic[]>): Uri[] {
    this._log?.(`[TSC] writeToStore: ${diagnostics.size} diagnostics`);
    const changed: Uri[] = [];
    const scannedUris = new Set<string>();

    for (const [filePath, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.file(filePath);
      const key = normalizeUriKey(uri);
      scannedUris.add(key);
      const result = this._store.set(uri, state, this.name);
      if (result) {
        changed.push(uri);
      }
    }

    // Reconcile: URIs that had problems in the previous scan but absent in this
    // scan have been fixed. TSC output only lists files WITH problems.
    const CLEAN_STATE: ProblemState = {
      severity: ProblemSeverity.None,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      fileCount: 0,
    };
    for (const key of this._lastScanUris) {
      if (!scannedUris.has(key)) {
        const uri = Uri.parse(key);
        if (this._store.set(uri, CLEAN_STATE, this.name)) {
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

  private aggregateFileState(diagnostics: TscDiagnostic[]): ProblemState {
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
}
