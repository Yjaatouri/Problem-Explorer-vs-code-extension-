import {
  Event,
  Uri,
  WorkspaceFolder,
  Diagnostic,
  DiagnosticChangeEvent,
  languages,
  workspace,
} from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { toProblemStatus, applySeverityOverrides } from './severityMapper';
import { ProblemStatus } from '../core/types';
import { isIgnored, precompilePatterns } from '../performance/ignoreFilter';
import { forensicLog } from '../forensicLogger';

/** Abstraction over VS Code API for reading diagnostics, enabling DI in tests */
export interface DiagnosticsDelegate {
  getAllDiagnostics(): [Uri, Diagnostic[]][];
  getUriDiagnostics(uri: Uri): Diagnostic[];
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
}

const defaultDelegate: DiagnosticsDelegate = {
  getAllDiagnostics: () => languages.getDiagnostics(),
  getUriDiagnostics: (uri: Uri) => languages.getDiagnostics(uri),
  getWorkspaceFolder: (uri: Uri) => workspace.getWorkspaceFolder(uri),
};

/** Ingests VS Code diagnostic events, converts them to `ProblemStatus`, and writes to the cache */
export class DiagnosticsManager {
  private readonly cache: ProblemCache;
  private readonly delegate: DiagnosticsDelegate;
  private severityOverrides: Record<string, Record<string, string>> | undefined;
  private readonly pendingClear = new Map<string, NodeJS.Timeout>();

  /** Direct passthrough to `languages.onDidChangeDiagnostics` */
  readonly onDidDiagnosticsChange: Event<DiagnosticChangeEvent>;

  constructor(cache: ProblemCache, delegate?: DiagnosticsDelegate) {
    this.cache = cache;
    this.delegate = delegate ?? defaultDelegate;
    this.onDidDiagnosticsChange = languages.onDidChangeDiagnostics;
  }

  /** Set the glob patterns that determine which URIs the cache should ignore. Pre-compiles patterns for efficiency. */
  setIgnorePatterns(patterns: string[]): void {
    precompilePatterns(patterns);
    this.cache.setIgnorePredicate((uri) => isIgnored(uri, patterns));
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

  /** Read the cached status for a URI. Returns `undefined` if not cached or not in a workspace folder. */
  getStatus(uri: Uri): ProblemStatus | undefined {
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return this.cache.get(uri, folder.uri);
  }

  private updateUri(uri: Uri, diagnostics: Diagnostic[], changed: Uri[]): void {
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) {
      return;
    }

    const uriKey = uri.toString();

    // When diagnostics arrive as empty, cancel any pending clear (from old code)
    const existingTimeout = this.pendingClear.get(uriKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.pendingClear.delete(uriKey);
    }

    if (diagnostics.length === 0) {
      // TEMPORARY VERIFICATION TEST: Disable cache clearing entirely
      // to prove that TypeScript's "clear then republish" pattern is the root cause.
      // If badges persist, hypothesis is VERIFIED.
      // If badges still disappear, hypothesis is DISPROVEN.
      forensicLog(`[VERIFY] updateUri SKIP-CLEAR: uriKey=${uriKey} diagnostics.length=0 -- cache clearing DISABLED for test`);
      return;
    }

    // Non-empty diagnostics
    const mapped = applySeverityOverrides(uri, diagnostics, this.severityOverrides);
    const status = toProblemStatus(mapped);
    const didChange = this.cache.set(uri, status, folder.uri);

    if (didChange) {
      changed.push(uri);
    }
  }
}