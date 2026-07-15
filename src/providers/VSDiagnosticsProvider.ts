import * as vscode from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
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
    private readonly provider: DiagnosticProvider,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly apiManager: ApiManager,
    private readonly decorationEngine: DecorationEngine,
    private readonly statusBarManager: StatusBarManager,
    private readonly trendTracker: TrendTracker,
    private readonly log: (msg: string) => void,
  ) {
    super();
    this.registerDisposable(this.provider.onDidUpdate((changed: vscode.Uri[]) => {
      this.diagEventCount++;
      this.log(`[FORENSIC:Step2] onDidUpdate: ${changed.length} changed URIs`);
      this.notifyApi(changed);
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
      this.log(`[FORENSIC:Step4-prep] flushUpdates: pending=${this.pendingUris.size}`);
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
        this.log(`[FORENSIC:Step4-prep] fireDidChange: ${uris.length} URIs (${this.dirtyUris.size} total before clear)`);
        this.dirtyUris.clear();
        this.decorationEngine.fireDidChange(uris);
      } else {
        this.log('[FORENSIC:Step4-prep] dirtyUris.size=0 → NOT firing fireDidChange');
      }
      this.statusBarManager.update();
      this.trendTracker.takeSnapshot();
    }, PROCESSING_DEBOUNCE_MS);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      const changedFolders = this.folderStatusManager.rebuildAll();
      this.log(`[FORENSIC:Step1-init] rebuildAll returned ${changedFolders.length} folders`);
      for (let i = 0; i < changedFolders.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
        if (folder) {
          this.apiManager.notifyChanged(changedFolders[i], folder.uri);
        }
      }
      this.decorationEngine.refresh();
      this.log('[FORENSIC:Step4] initial refresh() called → fireDidChange(undefined)');
      this.statusBarManager.update();
    }
  }

  protected onRefresh(): void {
    this.provider.refresh();
    const changedFolders = this.folderStatusManager.rebuildAll();
    for (let i = 0; i < changedFolders.length; i++) {
      const folder = vscode.workspace.getWorkspaceFolder(changedFolders[i]);
      if (folder) {
        this.apiManager.notifyChanged(changedFolders[i], folder.uri);
      }
    }
    this.decorationEngine.refresh();
    this.statusBarManager.update();
  }
}
