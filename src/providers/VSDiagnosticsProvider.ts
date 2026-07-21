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
      this.diagEventCount++;
      for (let i = 0; i < changed.length; i++) {
        this.pendingUris.add(changed[i].toString());
      }
      if (changed.length > 0) {
        this.flushUpdates?.();
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
      for (const uriStr of this.pendingUris) {
        const uri = vscode.Uri.parse(uriStr);
        this.dirtyUris.add(uriStr);
        const ancestors = this.folderStatusManager.updateAncestors(uri);
        this.notifyApi(ancestors);
        for (let k = 0; k < ancestors.length; k++) {
          this.dirtyUris.add(ancestors[k].toString());
        }
      }
      this.pendingUris.clear();

      if (this.dirtyUris.size > 0) {
        const uris = Array.from(this.dirtyUris, (s) => vscode.Uri.parse(s));
        this.dirtyUris.clear();
        this.decorationEngine.fireDidChange(uris);
      }
      this.statusBarManager.update();
      this.trendTracker.takeSnapshot();
    }, PROCESSING_DEBOUNCE_MS);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      // Flush any URIs that were queued before flushUpdates was initialized (e.g., from initializeAll scans)
      if (this.pendingUris.size > 0) {
        this.flushUpdates();
      }

      const changedFolders = this.folderStatusManager.rebuildAll();
      for (let i = 0; i < changedFolders.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
        if (folder) {
          this.apiManager.notifyChanged(changedFolders[i], folder.uri);
        }
      }
      this.decorationEngine.fireDidChange(changedFolders);
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
    this.decorationEngine.fireDidChange(changedFolders);
    this.statusBarManager.update();
  }
}
