import { Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity, TscConfig } from '../core/types';
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
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  private _disposed = false;
  private _scanning = false;
  private _pendingRefresh = false;
  private _enabled = true;
  private _autoScan = true;
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
    return this._autoScan;
  }

  updateConfig(cfg: TscConfig): void {
    this._enabled = cfg.enabled;
    this._autoScan = cfg.autoScan;
    this.timeoutMs = cfg.timeout;
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
    if (this._disposed) return;
    const changed = await this.runScan();
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
    if (this._disposed) return;
    if (!this._enabled) return;

    this._clearDebounce();

    return new Promise<void>((resolve) => {
      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = undefined;
        const changed = await this.runScan();
        if (changed.length > 0) {
          this._onDidUpdate.fire(changed);
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
    this._currentProject = undefined;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const allDiagnostics = new Map<string, TscDiagnostic[]>();
    const timing: Mutable<ScanTiming> = { totalMs: 0, resolveProjectsMs: 0, tscRunsMs: 0, parseMs: 0, storeWriteMs: 0 };
    const scanStart = performance.now();

    try {
      if (signal.aborted) return [];

      const resolveStart = performance.now();
      const projects = await this.projectResolver.resolveAll();
      timing.resolveProjectsMs = performance.now() - resolveStart;
      if (signal.aborted) return [];

      if (projects.length === 0) {
        this._lastScanErrors.push({
          tsconfigPath: '',
          message: 'No tsconfig.json found or TypeScript not available in workspace.',
        });
        return [];
      }

      const tscStart = performance.now();
      for (const project of projects) {
        if (signal.aborted) break;

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
          continue;
        }

        if (result.cancelled) break;

        if (result.timedOut) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.error ?? 'Timed out',
          });
          continue;
        }

        if (result.error) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.error,
          });
          continue;
        }

        if (result.exitCode !== 0 && this.isConfigError(result)) {
          this._lastScanErrors.push({
            tsconfigPath: project.tsconfigPath,
            message: result.stderr || result.stdout || `tsc exited with code ${result.exitCode}`,
          });
          continue;
        }

        const combined = result.stderr + '\n' + result.stdout;
        const parseStart = performance.now();
        const parsed = this.outputParser.parse(combined);
        timing.parseMs += performance.now() - parseStart;

        for (const diag of parsed) {
          const fileKey = path.resolve(diag.file);
          const existing = allDiagnostics.get(fileKey);
          if (existing) {
            existing.push(diag);
          } else {
            allDiagnostics.set(fileKey, [diag]);
          }
        }

        this._currentProject = undefined;
      }
      timing.tscRunsMs = performance.now() - tscStart;

      this.abortController = undefined;

      const writeStart = performance.now();
      const result = this.writeToStore(allDiagnostics);
      timing.storeWriteMs = performance.now() - writeStart;

      timing.totalMs = performance.now() - scanStart;
      this._lastScanDurationMs = timing.totalMs;
      this._lastScanTiming = timing;

      return result;
    } finally {
      this._scanning = false;
      this._currentProject = undefined;
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        const changed = await this.runScan();
        if (!this._disposed && changed.length > 0) {
          this._onDidUpdate.fire(changed);
        }
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
      combined.includes('parse') ||
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
      this._store.set(uri, state, this.name);
      changed.push(uri);
    }

    return changed;
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
