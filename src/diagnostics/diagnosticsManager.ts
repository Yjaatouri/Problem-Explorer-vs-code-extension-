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
import { ProblemState, ProblemSeverity, ProviderCapabilities, ScanProgress } from '../core/types';
import { precompilePatterns } from '../performance/ignoreFilter';
import { DiagnosticProvider } from '../providers/DiagnosticProvider';
import { normalizeUriKey } from '../core/uriKey';

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

/** Tracking record for a URI `vscodeDiagnostics` has owned at some point. */
interface TrackedUri {
  /** Timestamp of the most recent mutation we wrote for this URI. */
  lastTouchedMs: number;
  /** Last severity we wrote; lets us skip redundant work. */
  lastSeverity: ProblemSeverity;
}

/** Default delay (ms) between a save and the post-save reconciliation query. */
const DEFAULT_SAVE_RECON_DELAY_MS = 1500;

/** Ingests VS Code diagnostic events, converts them to `ProblemState`, and writes to ProblemStore */
export class DiagnosticsManager implements DiagnosticProvider {
  readonly name = 'vscodeDiagnostics';
  readonly capabilities: ProviderCapabilities = {
    extensions: [],
    realtime: true,
  };
  private readonly _store: ProblemStore;
  private readonly delegate: DiagnosticsDelegate;
  private severityOverrides: Record<string, Record<string, string>> | undefined;
  private _started = false;
  private _disposed = false;
  private diagListener: Disposable | undefined;
  private saveListener: Disposable | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconcileIntervalMs = 30000;
  /** Per-URI debounced save reconciliation: uri-string -> pending timer. */
  private readonly pendingSaveRecon = new Map<string, ReturnType<typeof setTimeout>>();
  /** URIs we currently own or have owned; used by periodic reconciliation. */
  private readonly _ownedUris = new Map<string, TrackedUri>();
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  private readonly _onDidProgressScan = new EventEmitter<ScanProgress>();
  private readonly _log: (msg: string) => void;

  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  readonly onDidProgressScan: Event<ScanProgress> = this._onDidProgressScan.event;

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

  constructor(
    store: ProblemStore,
    delegate?: DiagnosticsDelegate,
    log?: (msg: string) => void,
  ) {
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

  /**
   * Configure periodic reconciliation. `intervalMs === 0` disables the timer
   * (only the save-driven path will clear stale badges). Takes effect
   * immediately if the manager is already started.
   */
  setReconcileInterval(intervalMs: number): void {
    this.reconcileIntervalMs = Math.max(0, Math.floor(intervalMs));
    if (this._started) {
      this.stopReconcileTimer();
      this.startReconcileTimer();
    }
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
    // Only run fullScan if diagnostics already exist. If the language server
    // hasn't started yet, defer to startInitPoll() and onDidChangeDiagnostics
    // to avoid a redundant fullScan that would return nothing.
    const all = this.delegate.getAllDiagnostics();
    let hasAny = false;
    for (const [, diags] of all) {
      if (diags.length > 0) { hasAny = true; break; }
    }
    if (!hasAny) return;
    const changed = this.fullScan();
    if (changed.length > 0) {
      this._onDidUpdate.fire(changed);
    }
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

    // Save-driven reconciliation: when the user saves a file we previously
    // flagged, re-query VS Code's diagnostics a short delay later (giving the
    // language server time to re-analyze) and clear the badge if the file is
    // now truly clean. This is the primary fix path for non-TSC/ESLint files.
    this.saveListener = workspace.onDidSaveTextDocument((doc) => {
      this.scheduleSaveReconciliation(doc.uri);
    });

    this.startReconcileTimer();
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    this.diagListener?.dispose();
    this.diagListener = undefined;
    this.saveListener?.dispose();
    this.saveListener = undefined;
    this.clearPollTimer();
    this.stopReconcileTimer();
    this.cancelAllPendingSaveRecons();
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
    this._onDidProgressScan.dispose();
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
      // VS Code fires 0-diagnostics events when a file is closed or focus moves
      // to another editor — this does NOT mean the file's problems are gone,
      // only that VS Code is no longer analyzing it. Skip the empty-state write
      // unless the URI is the actively-open editor, so the badge survives.
      if (this.delegate.isActiveEditorUri(uri)) {
        if (this._store.clearIfOwner(uri, this.name)) {
          this.untrackUri(uri);
          changed.push(uri);
        }
      }
      return;
    }

    const mapped = applySeverityOverrides(uri, diagnostics, this.severityOverrides);
    const status = toProblemState(mapped);
    // Use the standard `set` path which honors provider priority — vscodeDiagnostics
    // (priority 5) cannot override an entry owned by tsc (10) or eslint (9).
    if (this._store.set(uri, status, this.name)) {
      this.trackUri(uri, status.severity);
      changed.push(uri);
    }
  }

  /**
   * Schedule a post-save reconciliation: wait `delay`, then re-query VS Code
   * diagnostics for `uri`. If still zero AND we still own it, clear the badge.
   * The delay gives the language server time to re-analyze the just-saved file.
   */
  private scheduleSaveReconciliation(uri: Uri, delay: number = DEFAULT_SAVE_RECON_DELAY_MS): void {
    // Ignore URIs we don't own — those are handled by tsc/eslint scanners
    // via the AutoScanner path, and we should not interfere with their
    // reconcile logic.
    const key = normalizeUriKey(uri);
    if (!this._ownedUris.has(key)) {
      return;
    }
    // Don't double-schedule for the same URI.
    const existing = this.pendingSaveRecon.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingSaveRecon.delete(key);
      this.runSaveReconciliation(uri);
    }, delay);
    this.pendingSaveRecon.set(key, timer);
  }

  /** Re-query diagnostics for a URI and clear the badge if truly empty. */
  private runSaveReconciliation(uri: Uri): void {
    if (this._disposed || !this._started) return;
    const folder = this.delegate.getWorkspaceFolder(uri);
    if (!folder) return;
    const diags = this.delegate.getUriDiagnostics(uri);
    if (diags.length === 0) {
      // Use owner-aware clear primitive. If tsc/eslint has since claimed this
      // URI, we silently do nothing — they'll handle their own cleanup.
      if (this._store.clearIfOwner(uri, this.name)) {
        this.untrackUri(uri);
        this._log(`[VSCodeDiagProvider] save-recon cleared: ${uri.fsPath}`);
        this._onDidUpdate.fire([uri]);
      }
    } else {
      // File got real diagnostics back: refresh the store entry via the normal
      // priority-gated path so ownership rules still apply.
      const changed: Uri[] = [];
      this.updateUri(uri, diags, changed);
      if (changed.length > 0) {
        this._onDidUpdate.fire(changed);
      }
    }
  }

  private cancelAllPendingSaveRecons(): void {
    for (const timer of this.pendingSaveRecon.values()) {
      clearTimeout(timer);
    }
    this.pendingSaveRecon.clear();
  }

  /**
   * Periodic reconciliation over our tracked URIs only (not the whole
   * workspace). Catches fixes from external sources: formatters, lint-on-type,
   * branch switches, etc.
   */
  private startReconcileTimer(): void {
    if (this.reconcileIntervalMs <= 0) return;
    this.reconcileTimer = setInterval(() => {
      this.runReconcile();
    }, this.reconcileIntervalMs);
  }

  private stopReconcileTimer(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  private runReconcile(): void {
    if (this._disposed || !this._started) return;
    if (this._ownedUris.size === 0) return;

    const changed: Uri[] = [];
    const stale: string[] = [];
    const now = Date.now();
    // Skip URIs touched within the last reconcile interval — fresh events still
    // in flight shouldn't fight the periodic clear (their save-recon or
    // active-editor path will handle them).
    const minAgeMs = this.reconcileIntervalMs;

    for (const [key, tracked] of this._ownedUris) {
      if (now - tracked.lastTouchedMs < minAgeMs) continue;
      let uri: Uri;
      try {
        uri = Uri.parse(key);
      } catch {
        stale.push(key);
        continue;
      }
      const folder = this.delegate.getWorkspaceFolder(uri);
      if (!folder) {
        // File left the workspace — drop it from tracking, but don't
        // touch the store; the store entry will be cleaned by other paths.
        stale.push(key);
        continue;
      }
      const diags = this.delegate.getUriDiagnostics(uri);
      if (diags.length === 0) {
        if (this._store.clearIfOwner(uri, this.name)) {
          changed.push(uri);
          stale.push(key);
        }
      }
    }

    if (changed.length > 0) {
      this._log(`[VSCodeDiagProvider] periodic recon cleared ${changed.length} URIs`);
      this._onDidUpdate.fire(changed);
    }
    for (const key of stale) {
      this._ownedUris.delete(key);
    }
  }

  private trackUri(uri: Uri, severity: ProblemSeverity): void {
    this._ownedUris.set(normalizeUriKey(uri), {
      lastTouchedMs: Date.now(),
      lastSeverity: severity,
    });
  }

  private untrackUri(uri: Uri): void {
    this._ownedUris.delete(normalizeUriKey(uri));
  }
}
