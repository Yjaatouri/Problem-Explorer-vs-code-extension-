import * as vscode from 'vscode';
import { DiagnosticProviderManager } from './DiagnosticProviderManager';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { ApiManager } from '../api/problemExplorerApi';
import { DecorationEngine } from '../decoration/decorationEngine';
import { StatusBarManager } from '../statusBar/statusBarManager';
import { TrendTracker } from '../trend/trendTracker';
import { debounce } from '../performance/debounce';
import { PROCESSING_DEBOUNCE_MS } from '../core/constants';
import { BaseProblemProvider } from './BaseProblemProvider';
import { chainCounters } from '../forensicLogger';
import { debugLog } from '../core/debug';

export class VSDiagnosticsProvider extends BaseProblemProvider {
  private diagEventCount = 0;
  private readonly dirtyUris = new Set<string>();
  private readonly pendingUris = new Set<string>();
  private flushUpdates: { (): void; cancel(): void } | undefined;

public get eventCount(): number { return this.diagEventCount; }

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly apiManager: ApiManager,
    private readonly decorationEngine: DecorationEngine,
    private readonly statusBarManager: StatusBarManager,
    private readonly trendTracker: TrendTracker,
    log: (msg: string) => void,
  ) {
    super();
    void log;
    this.registerDisposable(this.manager.onDidUpdateAll((changed: vscode.Uri[]) => {
      const ts = Date.now();
      this.diagEventCount++;
      chainCounters.vsDiagOnDidUpdateAllReceived++;
      debugLog(`[AUDIT:${ts}] VSDiag.onDidUpdateAll HANDLER ENTER changed=${changed.length} pendingUris=${this.pendingUris.size} flushExists=${!!this.flushUpdates}`);
      for (let i = 0; i < changed.length; i++) {
        this.pendingUris.add(changed[i].toString());
      }
      debugLog(`[AUDIT:${ts}] VSDiag.onDidUpdateAll added ${changed.length} URIs to pending, pendingUris now=${this.pendingUris.size}`);
      if (changed.length > 0) {
        debugLog(`[AUDIT:${ts}] VSDiag.onDidUpdateAll → calling flushUpdates()`);
        this.flushUpdates?.();
        debugLog(`[AUDIT:${Date.now()}] VSDiag.onDidUpdateAll → flushUpdates() returned`);
      } else {
        debugLog(`[AUDIT:${ts}] VSDiag.onDidUpdateAll EARLY RETURN — changed.length=0`);
      }
      debugLog(`[AUDIT:${Date.now()}] VSDiag.onDidUpdateAll HANDLER EXIT elapsed=${Date.now() - ts}ms`);
    }));
  }

  private notifyApi(uris: vscode.Uri[]): void {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] VSDiag.notifyApi() ENTER uris=${uris.length}`);
    let notified = 0;
    for (let i = 0; i < uris.length; i++) {
      const folder = vscode.workspace.getWorkspaceFolder(uris[i]);
      if (folder) {
        this.apiManager.notifyChanged(uris[i], folder.uri);
        notified++;
      } else {
        debugLog(`[AUDIT:${Date.now()}] VSDiag.notifyApi() SKIP — no workspace folder for uri=${uris[i].fsPath}`);
      }
    }
    debugLog(`[AUDIT:${Date.now()}] VSDiag.notifyApi() RETURN notified=${notified}/${uris.length}`);
  }

  markPending(uri: vscode.Uri): void {
    this.pendingUris.add(uri.toString());
  }

  flush(): void {
    this.flushUpdates?.();
  }

  protected onStart(): void {
    this.flushUpdates = debounce(() => {
      const ts = Date.now();
      chainCounters.vsDiagFlushUpdatesExecuted++;
      debugLog(`[AUDIT:${ts}] flushUpdates() ENTER pendingUris=${this.pendingUris.size} dirtyUris=${this.dirtyUris.size}`);
      for (const uriStr of this.pendingUris) {
        const uri = vscode.Uri.parse(uriStr);
        this.dirtyUris.add(uriStr);
        const ancestorsStart = Date.now();
        const ancestors = this.folderStatusManager.updateAncestors(uri);
        const ancestorsMs = Date.now() - ancestorsStart;
        debugLog(`[AUDIT:${Date.now()}] flushUpdates() updateAncestors(uri=${uriStr.split('/').pop() || uriStr}) returned ${ancestors.length} ancestors in ${ancestorsMs}ms`);
        const apiStart = Date.now();
        this.notifyApi(ancestors);
        debugLog(`[AUDIT:${Date.now()}] flushUpdates() notifyApi(${ancestors.length}) completed in ${Date.now() - apiStart}ms`);
        for (let k = 0; k < ancestors.length; k++) {
          this.dirtyUris.add(ancestors[k].toString());
        }
      }
      this.pendingUris.clear();
      debugLog(`[AUDIT:${Date.now()}] flushUpdates() pendingUris cleared, dirtyUris now=${this.dirtyUris.size}`);

      if (this.dirtyUris.size > 0) {
        const uris = Array.from(this.dirtyUris, (s) => vscode.Uri.parse(s));
        const dirtyCount = this.dirtyUris.size;
        this.dirtyUris.clear();
        chainCounters.fireDidChangeWithUris++;
        debugLog(`[AUDIT:${Date.now()}] flushUpdates() → decorationEngine.fireDidChange(${dirtyCount} URIs)`);
        const decoStart = Date.now();
        this.decorationEngine.fireDidChange(uris);
        debugLog(`[AUDIT:${Date.now()}] flushUpdates() fireDidChange completed in ${Date.now() - decoStart}ms`);
      } else {
        debugLog(`[AUDIT:${Date.now()}] flushUpdates() EARLY RETURN — dirtyUris.size=0, NOT calling fireDidChange`);
      }
      const sbStart = Date.now();
      this.statusBarManager.update();
      debugLog(`[AUDIT:${Date.now()}] flushUpdates() statusBar.update() completed in ${Date.now() - sbStart}ms`);
      const ttStart = Date.now();
      this.trendTracker.takeSnapshot();
      debugLog(`[AUDIT:${Date.now()}] flushUpdates() trendTracker.takeSnapshot() completed in ${Date.now() - ttStart}ms`);
      debugLog(`[AUDIT:${Date.now()}] flushUpdates() COMPLETE total=${Date.now() - ts}ms`);
    }, PROCESSING_DEBOUNCE_MS);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      // Flush any URIs that were queued before flushUpdates was initialized (e.g., from initializeAll scans)
      if (this.pendingUris.size > 0) {
        debugLog(`[AUDIT:${Date.now()}] VSDiag.onStart() flushing ${this.pendingUris.size} pre-queued pending URIs`);
        this.flushUpdates();
      }

      const rebuildStart = Date.now();
      const changedFolders = this.folderStatusManager.rebuildAll();
      debugLog(`[AUDIT:${Date.now()}] VSDiag.onStart() rebuildAll returned ${changedFolders.length} folders in ${Date.now() - rebuildStart}ms`);
      for (let i = 0; i < changedFolders.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
        if (folder) {
          this.apiManager.notifyChanged(changedFolders[i], folder.uri);
        }
      }
      debugLog(`[AUDIT:${Date.now()}] VSDiag.onStart() → decorationEngine.fireDidChange(${changedFolders.length} folders)`);
      this.decorationEngine.fireDidChange(changedFolders);
      this.statusBarManager.update();
    }
    debugLog(`[AUDIT:${Date.now()}] VSDiag.onStart() EXIT`);
  }

  protected onRefresh(): void {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] VSDiag.onRefresh() ENTER`);
    this.manager.refreshAll();
    const rebuildStart = Date.now();
    const changedFolders = this.folderStatusManager.rebuildAll();
    debugLog(`[AUDIT:${Date.now()}] VSDiag.onRefresh() rebuildAll returned ${changedFolders.length} folders in ${Date.now() - rebuildStart}ms`);
    for (let i = 0; i < changedFolders.length; i++) {
      const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
      if (folder) {
        this.apiManager.notifyChanged(changedFolders[i], folder.uri);
      }
    }
    debugLog(`[AUDIT:${Date.now()}] VSDiag.onRefresh() → decorationEngine.fireDidChange(${changedFolders.length})`);
    this.decorationEngine.fireDidChange(changedFolders);
    this.statusBarManager.update();
    debugLog(`[AUDIT:${Date.now()}] VSDiag.onRefresh() COMPLETE total=${Date.now() - ts}ms`);
  }
}
