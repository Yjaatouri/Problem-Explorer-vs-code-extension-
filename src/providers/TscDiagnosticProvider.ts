import { Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProblemSeverity } from '../core/types';
import { ProjectResolver, TypeScriptProject } from '../typescript/ProjectResolver';
import { TscRunner, TscRunOptions } from '../typescript/TscRunner';
import { TscOutputParser, TscDiagnostic } from '../typescript/TscOutputParser';
import * as path from 'path';

export interface TscScanContext {
  readonly projects: TypeScriptProject[];
  readonly diagnostics: Map<string, TscDiagnostic[]>;
}

export class TscDiagnosticProvider implements DiagnosticProvider {
  readonly name = 'tsc';
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  private _disposed = false;
  private readonly projectResolver: ProjectResolver;
  private readonly tscRunner: TscRunner;
  private readonly outputParser: TscOutputParser;
  private abortController: AbortController | undefined;

  get store(): ProblemStore {
    return this._store;
  }

  constructor(
    store: ProblemStore,
    projectResolver?: ProjectResolver,
    tscRunner?: TscRunner,
    outputParser?: TscOutputParser,
  ) {
    this._store = store;
    this.projectResolver = projectResolver ?? new ProjectResolver();
    this.tscRunner = tscRunner ?? new TscRunner();
    this.outputParser = outputParser ?? new TscOutputParser();
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
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (this._disposed) return;
    const changed = await this.runScan();
    if (changed.length > 0) {
      this._onDidUpdate.fire(changed);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this._onDidUpdate.dispose();
  }

  async runScan(): Promise<Uri[]> {
    const projects = await this.projectResolver.resolveAll();
    if (projects.length === 0) return [];

    this.abortController = new AbortController();
    const allDiagnostics = new Map<string, TscDiagnostic[]>();

    for (const project of projects) {
      const options: TscRunOptions = {
        typescriptPath: project.typescriptPath,
        tsconfigPath: project.tsconfigPath,
        signal: this.abortController.signal,
      };

      let result;
      try {
        result = await this.tscRunner.run(options);
      } catch {
        continue;
      }

      if (result.cancelled) break;

      const combined = result.stderr + '\n' + result.stdout;
      const parsed = this.outputParser.parse(combined);

      for (const diag of parsed) {
        const fileKey = path.resolve(diag.file);
        const existing = allDiagnostics.get(fileKey);
        if (existing) {
          existing.push(diag);
        } else {
          allDiagnostics.set(fileKey, [diag]);
        }
      }
    }

    this.abortController = undefined;
    return this.writeToStore(allDiagnostics);
  }

  private writeToStore(diagnostics: Map<string, TscDiagnostic[]>): Uri[] {
    const changed: Uri[] = [];
    const seen = new Set<string>();

    for (const [filePath, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.file(filePath);
      const key = uri.toString();
      seen.add(key);
      this._store.set(uri, state);
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
