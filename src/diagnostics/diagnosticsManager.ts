import {
  Uri,
  WorkspaceFolder,
  Diagnostic,
  DiagnosticChangeEvent,
  Disposable,
  Event,
  EventEmitter,
  languages,
  window,
  workspace,
} from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { toProblemState, applySeverityOverrides } from './severityMapper';
import { ProblemState } from '../core/types';
import { precompilePatterns } from '../performance/ignoreFilter';
import { DiagnosticProvider } from '../providers/DiagnosticProvider';

/** Abstraction over VS Code API for reading diagnostics, enabling DI in tests */
export interface DiagnosticsDelegate {
  getAllDiagnostics(): [Uri, Diagnostic[]][];
  getUriDiagnostics(uri: Uri): Diagnostic[];
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  isActiveEditorUri(uri: Uri): boolean;
}

const defaultDelegate: DiagnosticsDelegate = {
  getAllDiagnostics: () => [],
  getUriDiagnostics: () => [],
  getWorkspaceFolder: (uri: Uri) => workspace.getWorkspaceFolder(uri),
  isActiveEditorUri: (uri: Uri) => {
    const editor = window.activeTextEditor;
    return editor ? editor.document.uri.toString() === uri.toString() : false;
  },
};

/** Ingests VS Code diagnostic events, converts them to `ProblemState`, and writes to ProblemStore */
export class DiagnosticsManager implements DiagnosticProvider {
  readonly name = 'vscodeDiagnostics';
  private readonly _store: ProblemStore;
  private readonly delegate: DiagnosticsDelegate;
  private severityOverrides: Record<string, Record<string, string>> | undefined;
  private _started = false;
  private _disposed = false;
  private diagListener: Disposable | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  private readonly _log: (msg: string) => void;

  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;

  get scanning(): boolean {
    return false;
  }

  get autoScan(): boolean {
    return true;
  }

  get enabled(): boolean {
    return true;
  }

  get store(): ProblemStore {
    return this._store;
  }

  get severityOverridesValue(): Record<string, Record<string, string>> | undefined {
    return this.severityOverrides;
  }

  constructor(store: ProblemStore, delegate?: DiagnosticsDelegate, log?: (msg: string) => void) {
    this._store = store;
    this.delegate = delegate ?? defaultDelegate;
    this._log = log ?? (() => {});
  }

  /** Set the glob patterns that determine which URIs the store should ignore. Pre-compiles patterns for efficiency. */
  setIgnorePatterns(patterns: string[]): void {
    precompilePatterns(patterns);
  }

  /** Set per-extension severity overrides (from `Config.severityOverrides`) */
  setSeverityOverrides(overrides: Record<string, Record<string, string>> | undefined): void {
    this.severityOverrides = overrides;
  }

  /** Scan all diagnostics in the workspace and seed the store. Returns URIs whose status changed. */
  fullScan(): Uri[] {
    const allDiagnostics = this.delegate.getAllDiagnostics();
    const changed: Uri[] = [];
    for (let i = 0; i < allDiagnostics.length; i++) {
      const [uri, diagnostics] = allDiagnostics[i];
      this.updateUri(uri, diagnostics, changed);
    }
    return changed;
  }

  /** Incrementally update the store from a diagnostic change event. Returns URIs whose status changed. */
  processChanges(event: DiagnosticChangeEvent): Uri[] {
    const uris = event.uris;
    const changed: Uri[] = [];
    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      const diagnostics = this.delegate.getUriDiagnostics(uri);
      this.updateUri(uri, diagnostics, changed);
    }
    return changed;
  }

  /** Read the status for a URI. Returns `undefined` if not in store or not in a workspace folder. */
  getStatus(uri: Uri): ProblemState | undefined {
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return this._store.get(uri);
  }

  /** ───── DiagnosticProvider implementation ───── */

  initialize(): void {
    if (this._disposed) return;
    this.fullScan();
  }

  start(): void {
    if (this._disposed || this._started) return;
    this._started = true;

    this.diagListener = languages.onDidChangeDiagnostics((e) => {
      const changed = this.processChanges(e);
      if (changed.length > 0) {
        this._log(`[VSCodeDiagProvider] processChanges: ${changed.length} changed URIs`);
        this._onDidUpdate.fire(changed);
      }
    });
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    this.diagListener?.dispose();
    this.diagListener = undefined;
    this.clearPollTimer();
  }

  refresh(): void {
    if (this._disposed) return;
    const changed = this.fullScan();
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

  /** Run fullScan on an interval until diagnostics arrive (max 10 attempts at 2s). */
  startInitPoll(): void {
    if (this._disposed) return;
    let pollAttempts = 0;
    this.pollTimer = setInterval(() => {
      pollAttempts++;
      const totalDiags = languages.getDiagnostics();
      let totalCount = 0;
      for (let i = 0; i < totalDiags.length; i++) {
        totalCount += totalDiags[i][1].length;
      }
      this._log(`[INIT-POLL] attempt=${pollAttempts} totalDiags=${totalCount}`);
      if (totalCount > 0 || pollAttempts >= 10) {
        this.clearPollTimer();
        const changed = this.fullScan();
        this._log(`[INIT-POLL] late fullScan: ${changed.length} changed`);
        if (changed.length > 0) {
          this._onDidUpdate.fire(changed);
        }
      }
    }, 2000);
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private updateUri(uri: Uri, diagnostics: Diagnostic[], changed: Uri[]): void {
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) {
      return;
    }

    if (diagnostics.length === 0) {
      if (!this.delegate.isActiveEditorUri(uri)) {
        return;
      }
      if (this._store.delete(uri)) {
        changed.push(uri);
      }
      return;
    }

    const mapped = applySeverityOverrides(uri, diagnostics, this.severityOverrides);
    const status = toProblemState(mapped);
    this._store.set(uri, status, this.name);
    changed.push(uri);
  }
}
