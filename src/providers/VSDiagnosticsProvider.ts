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
    private readonly log: (msg: string) => void,
  ) {
    super();
    this.registerDisposable(this.manager.onDidUpdateAll((changed: vscode.Uri[]) => {
      this.diagEventCount++;
      chainCounters.vsDiagOnDidUpdateAllReceived++;
      console.log(`[LOG:VSDiag] onDidUpdateAll RECEIVED — ${changed.length} URIs — pendingUris was ${this.pendingUris.size}`);
      this.log(`[FORENSIC:Step2] onDidUpdate: ${changed.length} changed URIs`);
      for (let i = 0; i < changed.length; i++) {
        this.pendingUris.add(changed[i].toString());
      }
      console.log(`[LOG:VSDiag] pendingUris now ${this.pendingUris.size} — flushUpdates exists? ${!!this.flushUpdates}`);
      if (changed.length > 0) {
        this.flushUpdates?.();
        console.log(`[LOG:VSDiag] flushUpdates() called`);
      } else {
        console.log(`[LOG:VSDiag] changed.length=0 → NOT calling flushUpdates()`);
      }
    }));
  }

  private notifyApi(uris: vscode.Uri[]): void {
    for (let i = 0; i < uris.length; i++) {
      const folder = vscode.workspace.getWorkspaceFolder(uris[i]);
      if (folder) {
        this.apiManager.notifyChanged(uris[i], folder.uri);
      }
    }
  }

  markPending(uri: vscode.Uri): void {
    this.pendingUris.add(uri.toString());
  }

  flush(): void {
    this.flushUpdates?.();
  }

  protected onStart(): void {
    this.flushUpdates = debounce(() => {
      chainCounters.vsDiagFlushUpdatesExecuted++;
      console.log(`[LOG:flushUpdates] EXECUTING — pendingUris.size=${this.pendingUris.size} initialDirty=${this.dirtyUris.size}`);
      this.log(`[FORENSIC:Step4-prep] flushUpdates: pending=${this.pendingUris.size}`);
      for (const uriStr of this.pendingUris) {
        const uri = vscode.Uri.parse(uriStr);
        this.dirtyUris.add(uriStr);
        const ancestors = this.folderStatusManager.updateAncestors(uri);
        console.log(`[LOG:flushUpdates] updateAncestors("${uriStr.split('/').pop() || uriStr}") returned ${ancestors.length} ancestor URIs`);
        this.notifyApi(ancestors);
        for (let k = 0; k < ancestors.length; k++) {
          this.dirtyUris.add(ancestors[k].toString());
        }
      }
      this.pendingUris.clear();

      if (this.dirtyUris.size > 0) {
        const uris = Array.from(this.dirtyUris, (s) => vscode.Uri.parse(s));
        console.log(`[LOG:flushUpdates] firing fireDidChange with ${uris.length} URIs`);
        this.log(`[FORENSIC:Step4-prep] fireDidChange: ${uris.length} URIs (${this.dirtyUris.size} total before clear)`);
        this.log(`[VERIFY] DecorationEngine.fireDidChange called with ${uris.length} URIs (from flushUpdates)`);
        this.dirtyUris.clear();
        chainCounters.fireDidChangeWithUris++;
        this.decorationEngine.fireDidChange(uris);
      } else {
        console.log(`[LOG:flushUpdates] dirtyUris.size=0 → NOT firing fireDidChange`);
        this.log('[FORENSIC:Step4-prep] dirtyUris.size=0 → NOT firing fireDidChange');
      }
      this.statusBarManager.update();
      this.trendTracker.takeSnapshot();
      console.log(`[LOG:flushUpdates] COMPLETE — statusBar updated, trend snapshot taken`);
    }, PROCESSING_DEBOUNCE_MS);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      // Flush any URIs that were queued before flushUpdates was initialized (e.g., from initializeAll scans)
      if (this.pendingUris.size > 0) {
        this.log(`[VERIFY] Flushing ${this.pendingUris.size} pending URIs queued before flushUpdates was ready`);
        this.flushUpdates();
      }

      const changedFolders = this.folderStatusManager.rebuildAll();
      this.log(`[FORENSIC:Step1-init] rebuildAll returned ${changedFolders.length} folders`);
      for (let i = 0; i < changedFolders.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
        if (folder) {
          this.apiManager.notifyChanged(changedFolders[i], folder.uri);
        }
      }
      // Use targeted folder URIs instead of undefined to reduce Explorer re-query
      this.decorationEngine.fireDidChange(changedFolders);
      this.log(`[FORENSIC:Step4] initial fireDidChange with ${changedFolders.length} folder URIs (targeted, not full refresh)`);
      this.log(`[VERIFY] DecorationEngine.fireDidChange called with ${changedFolders.length} folder URIs (from onStart rebuildAll)`);
      this.statusBarManager.update();
    }
  }

  protected onRefresh(): void {
    this.manager.refreshAll();
    const changedFolders = this.folderStatusManager.rebuildAll();
    for (let i = 0; i < changedFolders.length; i++) {
      const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
      if (folder) {
        this.apiManager.notifyChanged(changedFolders[i], folder.uri);
      }
    }
    // Use targeted folder URIs instead of undefined to reduce Explorer re-query
    this.decorationEngine.fireDidChange(changedFolders);
    this.statusBarManager.update();
  }
}
