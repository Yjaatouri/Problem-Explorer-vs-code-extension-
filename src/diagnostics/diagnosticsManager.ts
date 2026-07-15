import {
  Event,
  Uri,
  WorkspaceFolder,
  Diagnostic,
  DiagnosticChangeEvent,
  languages,
  window,
  workspace,
} from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { toProblemState, applySeverityOverrides } from './severityMapper';
import { ProblemState } from '../core/types';
import { precompilePatterns } from '../performance/ignoreFilter';

/** Abstraction over VS Code API for reading diagnostics, enabling DI in tests */
export interface DiagnosticsDelegate {
  getAllDiagnostics(): [Uri, Diagnostic[]][];
  getUriDiagnostics(uri: Uri): Diagnostic[];
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  isActiveEditorUri(uri: Uri): boolean;
}

const defaultDelegate: DiagnosticsDelegate = {
  getAllDiagnostics: () => languages.getDiagnostics(),
  getUriDiagnostics: (uri: Uri) => languages.getDiagnostics(uri),
  getWorkspaceFolder: (uri: Uri) => workspace.getWorkspaceFolder(uri),
  isActiveEditorUri: (uri: Uri) => {
    const editor = window.activeTextEditor;
    return editor ? editor.document.uri.toString() === uri.toString() : false;
  },
};

/** Ingests VS Code diagnostic events, converts them to `ProblemState`, and writes to ProblemStore */
export class DiagnosticsManager {
  private readonly store: ProblemStore;
  private readonly delegate: DiagnosticsDelegate;
  private severityOverrides: Record<string, Record<string, string>> | undefined;

  get severityOverridesValue(): Record<string, Record<string, string>> | undefined {
    return this.severityOverrides;
  }

  /** Direct passthrough to `languages.onDidChangeDiagnostics` */
  readonly onDidDiagnosticsChange: Event<DiagnosticChangeEvent>;

  constructor(store: ProblemStore, delegate?: DiagnosticsDelegate) {
    this.store = store;
    this.delegate = delegate ?? defaultDelegate;
    this.onDidDiagnosticsChange = languages.onDidChangeDiagnostics;
  }

  /** Set the glob patterns that determine which URIs the store should ignore. Pre-compiles patterns for efficiency. */
  setIgnorePatterns(patterns: string[]): void {
    precompilePatterns(patterns);
  }

  /** Set per-extension severity overrides (from `Config.severityOverrides`) */
  setSeverityOverrides(overrides: Record<string, Record<string, string>> | undefined): void {
    this.severityOverrides = overrides;
  }

  /** Scan all diagnostics in the workspace and seed the cache. Returns URIs whose status changed. */
  fullScan(): Uri[] {
    const allDiagnostics = this.delegate.getAllDiagnostics();
    const changed: Uri[] = [];

    for (let i = 0; i < allDiagnostics.length; i++) {
      const [uri, diagnostics] = allDiagnostics[i];
      this.updateUri(uri, diagnostics, changed);
    }

    return changed;
  }

  /** Incrementally update the cache from a diagnostic change event. Returns URIs whose status changed. */
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

  getEventDiagnosticsCounts(event: DiagnosticChangeEvent): Array<{ uri: string; err: number; warn: number; info: number; hint: number }> {
    const result: Array<{ uri: string; err: number; warn: number; info: number; hint: number }> = [];
    for (let i = 0; i < event.uris.length; i++) {
      const d = this.delegate.getUriDiagnostics(event.uris[i]);
      result.push({
        uri: event.uris[i].toString(true),
        err: d.filter((dx: Diagnostic) => dx.severity === 0).length,
        warn: d.filter((dx: Diagnostic) => dx.severity === 1).length,
        info: d.filter((dx: Diagnostic) => dx.severity === 2).length,
        hint: d.filter((dx: Diagnostic) => dx.severity === 3).length,
      });
    }
    return result;
  }

  /** Read the status for a URI. Returns `undefined` if not in store or not in a workspace folder. */
  getStatus(uri: Uri): ProblemState | undefined {
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return this.store.get(uri);
  }

  private updateUri(uri: Uri, diagnostics: Diagnostic[], changed: Uri[]): void {
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) {
      return;
    }

    if (diagnostics.length === 0) {
      // Only delete the entry when the zero-diagnostic event is for the
      // active editor. Non-active files may report transient 0-diagnostics due
      // to lazy TypeScript re-evaluation, ESLint batches, or multi-source races.
      // When the user navigates back to the file, a fresh diagnostic event will
      // re-create the entry.
      if (!this.delegate.isActiveEditorUri(uri)) {
        return;
      }
      if (this.store.delete(uri)) {
        changed.push(uri);
      }
      return;
    }

    // Non-empty diagnostics — map and update the store
    const mapped = applySeverityOverrides(uri, diagnostics, this.severityOverrides);
    const status = toProblemState(mapped);
    this.store.set(uri, status);
    changed.push(uri);
  }
}
