import { Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity, TscConfig, ProviderCapabilities, ScanProgress } from '../core/types';
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
  private abortController: AbortController | undefined;
  private _lastScanErrors: TscScanError[] = [];
  private _lastScanDurationMs = 0;
  private _lastScanTiming: ScanTiming | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _refreshResolve: (() => void) | undefined;
  private _currentProject: string | undefined;
  private _maxConcurrentScans = 1;

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
    this._enabled = cfg.enabled;
    this.timeoutMs = cfg.timeout;
    this._maxConcurrentScans = cfg.maxConcurrentScans;
    this.projectResolver.useWorkspaceVersion = cfg.useWorkspaceVersion;
  }

  constructor(
    store: ProblemStore,
    options?: {
      projectResolver?: ProjectResolver;
      tscRunner?: TscRunner;
      outputParser?: TscOutputParser;
      timeoutMs?: number;
      refreshDebounceMs?: number;
    },
  ) {
    this._store = store;
    this.projectResolver = options?.projectResolver ?? new ProjectResolver();
    this.tscRunner = options?.tscRunner ?? new TscRunner();
    this.outputParser = options?.outputParser ?? new TscOutputParser();
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TSC_TIMEOUT_MS;
    this.refreshDebounceMs = options?.refreshDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async initialize(): Promise<void> {
    if (this._disposed) { console.log('[LOG:TSC-init] DISPOSED — returning'); return; }
    const changed = await this.runScan();
    console.log(`[LOG:TSC-init] runScan returned changed.length=${changed.length}`);
    if (changed.length > 0) {
      console.log(`[LOG:TSC-init] BEFORE _onDidUpdate.fire() — ${changed.length} URIs`);
      this._onDidUpdate.fire(changed);
      console.log(`[LOG:TSC-init] AFTER _onDidUpdate.fire()`);
    } else {
      console.log(`[LOG:TSC-init] changed.length=0 → SKIPPING _onDidUpdate.fire()`);
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
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: msg });
        return [];
      }

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
          const fileKey = path.resolve(diag.file);
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
      const result = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;

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
      return process.memoryUsage();
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
    const changed: Uri[] = [];

    for (const [filePath, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.file(filePath);
      const result = this._store.set(uri, state, this.name);
      if (result) {
        changed.push(uri);
      }
    }

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
