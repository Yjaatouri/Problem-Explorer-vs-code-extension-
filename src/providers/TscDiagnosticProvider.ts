import { Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity, TscConfig, ProviderCapabilities, ScanProgress } from '../core/types';
import { ProjectResolver, TypeScriptProject } from '../typescript/ProjectResolver';
import { TscRunner, TscRunOptions, DEFAULT_TSC_TIMEOUT_MS } from '../typescript/TscRunner';
import { TscOutputParser, TscDiagnostic } from '../typescript/TscOutputParser';
import { chainCounters } from '../forensicLogger';
import { debugLog } from '../core/debug';
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
    projectResolver?: ProjectResolver,
    tscRunner?: TscRunner,
    outputParser?: TscOutputParser,
    timeoutMs?: number,
    refreshDebounceMs?: number,
  ) {
    this._store = store;
    this.projectResolver = projectResolver ?? new ProjectResolver();
    this.tscRunner = tscRunner ?? new TscRunner();
    this.outputParser = outputParser ?? new TscOutputParser();
    this.timeoutMs = timeoutMs ?? DEFAULT_TSC_TIMEOUT_MS;
    this.refreshDebounceMs = refreshDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async initialize(): Promise<void> {
    if (this._disposed) { console.log('[LOG:TSC-init] DISPOSED — returning'); return; }
    const changed = await this.runScan();
    console.log(`[LOG:TSC-init] runScan returned changed.length=${changed.length}`);
    if (changed.length > 0) {
      chainCounters.providerRunScanReturned++;
      console.log(`[LOG:TSC-init] BEFORE _onDidUpdate.fire() — ${changed.length} URIs`);
      this._onDidUpdate.fire(changed);
      chainCounters.providerOnDidUpdateFired++;
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
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] TSC.refresh() ENTER name=${this.name} _enabled=${this._enabled} _disposed=${this._disposed} _scanning=${this._scanning} _pendingRefresh=${this._pendingRefresh}`);
    chainCounters.providerRefreshCalled++;
    if (this._disposed) { debugLog(`[AUDIT:${ts}] TSC.refresh() EARLY RETURN — disposed`); return; }
    if (!this._enabled) { debugLog(`[AUDIT:${ts}] TSC.refresh() EARLY RETURN — disabled`); return; }

    this._clearDebounce();
    debugLog(`[AUDIT:${ts}] TSC.refresh() debounce cleared, setting ${this.refreshDebounceMs}ms timer`);

    return new Promise<void>((resolve) => {
      this._debounceTimer = setTimeout(async () => {
        const fireTs = Date.now();
        debugLog(`[AUDIT:${fireTs}] TSC.refresh() debounce FIRED (waited ${fireTs - ts}ms)`);
        this._debounceTimer = undefined;
        try {
          const changed = await this.runScan();
          debugLog(`[AUDIT:${Date.now()}] TSC.refresh() runScan returned changed.length=${changed.length} changed=[${changed.map(u => u.fsPath).join(', ')}]`);
          if (changed.length > 0 && !this._disposed) {
            chainCounters.providerRunScanReturned++;
            debugLog(`[AUDIT:${Date.now()}] TSC.refresh() firing _onDidUpdate with ${changed.length} URIs`);
            this._onDidUpdate.fire(changed);
            chainCounters.providerOnDidUpdateFired++;
            debugLog(`[AUDIT:${Date.now()}] TSC.refresh() _onDidUpdate fired`);
          } else {
            debugLog(`[AUDIT:${Date.now()}] TSC.refresh() SKIP _onDidUpdate — changed.length=${changed.length} _disposed=${this._disposed}`);
          }
        } catch (err) {
          debugLog(`[AUDIT:${Date.now()}] TSC.refresh() runScan THREW: ${err instanceof Error ? err.message : String(err)}`);
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
  }

  async runScan(): Promise<Uri[]> {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] TSC.runScan() ENTER _disposed=${this._disposed} _enabled=${this._enabled} _scanning=${this._scanning}`);
    if (this._disposed) { debugLog(`[AUDIT:${Date.now()}] TSC.runScan() EARLY RETURN — disposed`); return []; }
    if (!this._enabled) { debugLog(`[AUDIT:${Date.now()}] TSC.runScan() EARLY RETURN — disabled`); return []; }
    if (this._scanning) {
      this._pendingRefresh = true;
      debugLog(`[AUDIT:${Date.now()}] TSC.runScan() EARLY RETURN — already scanning, _pendingRefresh set to true`);
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
        debugLog(`[AUDIT:${Date.now()}] TSC.runScan() EARLY RETURN — signal aborted before resolve`);
        return [];
      }

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'resolving', message: 'Resolving TypeScript projects...' });

      const resolveStart = performance.now();
      const projects = await this.projectResolver.resolveAll();
      timing.resolveProjectsMs = performance.now() - resolveStart;
      debugLog(`[AUDIT:${Date.now()}] TSC.runScan() ProjectResolver.resolveAll() returned ${projects.length} projects in ${timing.resolveProjectsMs.toFixed(0)}ms`);
      if (signal.aborted) {
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'cancelled', message: 'Scan cancelled' });
        debugLog(`[AUDIT:${Date.now()}] TSC.runScan() EARLY RETURN — signal aborted after resolve`);
        return [];
      }

      if (projects.length === 0) {
        const msg = 'No tsconfig.json found or TypeScript not available in workspace.';
        debugLog(`[AUDIT:${Date.now()}] TSC.runScan() EARLY RETURN — ${msg}`);
        this._lastScanErrors.push({ tsconfigPath: '', message: msg });
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: msg });
        return [];
      }

      const tscStart = performance.now();
      const semaphore = this.makeSemaphore(this._maxConcurrentScans);
      let totalDiagsParsed = 0;
      await Promise.all(projects.map(async (project) => {
        await semaphore.acquire();
        if (signal.aborted) {
          semaphore.release();
          return;
        }

        const projectLabel = path.basename(project.projectRoot);
        this._onDidProgressScan.fire({ providerName: this.name, phase: 'scanning', message: `Scanning ${projectLabel}...`, detail: project.tsconfigPath });

        const runnerStart = performance.now();
        debugLog(`[AUDIT:${Date.now()}] TSC.runScan() Running tsc for project=${project.tsconfigPath}`);

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
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() tscRunner.run() completed in ${(performance.now() - runnerStart).toFixed(0)}ms exitCode=${result.exitCode} cancelled=${result.cancelled} timedOut=${result.timedOut} stdout=${result.stdout.length}chars stderr=${result.stderr.length}chars`);
        } catch (err: unknown) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() tscRunner.run() THREW: ${err instanceof Error ? err.message : String(err)}`);
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: err instanceof Error ? err.message : String(err),
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.cancelled) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() SKIP — runner cancelled`);
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.timedOut) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() SKIP — runner timed out`);
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.error ?? 'Timed out',
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.error) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() SKIP — runner error: ${result.error}`);
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.error,
          });
          this._currentProject = undefined;
          semaphore.release();
          return;
        }

        if (result.exitCode !== 0 && this.isConfigError(result)) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() SKIP — config error exitCode=${result.exitCode}`);
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
        debugLog(`[AUDIT:${Date.now()}] TSC.runScan() outputParser.parse() returned ${parsed.length} diagnostics in ${parseMs.toFixed(0)}ms`);

        totalDiagsParsed += parsed.length;

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
        debugLog(`[AUDIT:${Date.now()}] TSC.runScan() aggregated ${parsed.length} diags across ${fileCount.size} files for project=${projectLabel}`);

        this._currentProject = undefined;
        semaphore.release();
      }));
      timing.tscRunsMs = performance.now() - tscStart;
      debugLog(`[AUDIT:${Date.now()}] TSC.runScan() all projects done in ${timing.tscRunsMs.toFixed(0)}ms total parsed=${totalDiagsParsed} total files=${allDiagnostics.size}`);

      this.abortController = undefined;

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'writing', message: 'Writing results to store...' });

      const writeStart = performance.now();
      const result = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;
      debugLog(`[AUDIT:${Date.now()}] TSC.runScan() writeToStore returned ${result.length} changed URIs in ${timing.storeWriteMs.toFixed(0)}ms`);

      timing.totalMs = performance.now() - scanStart;
      this._lastScanDurationMs = timing.totalMs;
      this._lastScanTiming = timing;

      if (result.length === 0 && this._lastScanErrors.length > 0) {
        for (const e of this._lastScanErrors) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() error: ${e.tsconfigPath || '(workspace)'} — ${e.message}`);
        }
      }

      this._onDidProgressScan.fire({ providerName: this.name, phase: 'completed', message: `Completed in ${timing.totalMs.toFixed(0)}ms` });
      debugLog(`[AUDIT:${Date.now()}] TSC.runScan() RETURN ${result.length} changed URIs (totalMs=${timing.totalMs.toFixed(0)}ms)`);

      return result;
    } finally {
      this._scanning = false;
      this._currentProject = undefined;
      debugLog(`[AUDIT:${Date.now()}] TSC.runScan() finally _scanning=false _pendingRefresh=${this._pendingRefresh}`);
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        const changed = await this.runScan();
        if (!this._disposed && changed.length > 0) {
          debugLog(`[AUDIT:${Date.now()}] TSC.runScan() pending refresh completed: ${changed.length} URIs`);
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
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] TSC.writeToStore() ENTER diagFiles=${diagnostics.size} provider="${this.name}"`);
    const changed: Uri[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const [filePath, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.file(filePath);
      const result = this._store.set(uri, state, this.name);
      debugLog(`[AUDIT:${Date.now()}] TSC.writeToStore() file="${filePath}" diags=${fileDiags.length} severity=${state.severity} errors=${state.errorCount} warnings=${state.warningCount} store.set()=${result}`);
      if (result) {
        changed.push(uri);
        accepted++;
      } else {
        rejected++;
      }
    }

    debugLog(`[AUDIT:${Date.now()}] TSC.writeToStore() RETURN accepted=${accepted} rejected=${rejected} changed=${changed.length}`);
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
