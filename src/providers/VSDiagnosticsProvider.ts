import * as vscode from 'vscode';
import { Event, EventEmitter } from 'vscode';
import { DiagnosticProviderManager } from './DiagnosticProviderManager';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { ApiManager } from '../api/problemExplorerApi';
import { DecorationEngine } from '../decoration/decorationEngine';
import { StatusBarManager } from '../statusBar/statusBarManager';
import { TrendTracker } from '../trend/trendTracker';
import { debounce } from '../performance/debounce';
import { PROCESSING_DEBOUNCE_MS } from '../core/constants';
import { BaseProblemProvider } from './BaseProblemProvider';
import { ScanScheduler } from '../scanner/ScanScheduler';
import { ScanProgress, ProviderCapabilities } from '../core/types';



export class VSDiagnosticsProvider extends BaseProblemProvider {
  readonly name = 'vsDiagnostics';
  readonly capabilities: ProviderCapabilities = { extensions: [], realtime: true, manualScan: false, startupScan: false };
  readonly autoScan = true;
  readonly enabled = true;
  private readonly _onDidUpdate = new EventEmitter<vscode.Uri[]>();
  readonly onDidUpdate: Event<vscode.Uri[]> = this._onDidUpdate.event;
  private readonly _onDidProgressScan = new EventEmitter<ScanProgress>();
  readonly onDidProgressScan: Event<ScanProgress> = this._onDidProgressScan.event;
  readonly scanning = false;
  private diagEventCount = 0;
  private readonly dirtyUris = new Set<string>();
  private readonly pendingUris = new Set<string>();
  private flushUpdates: { (): void; cancel(): void; flush(): void } | undefined;
  private readonly _log: (msg: string) => void;

public get eventCount(): number { return this.diagEventCount; }

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly apiManager: ApiManager,
    private readonly decorationEngine: DecorationEngine,
    private readonly statusBarManager: StatusBarManager,
    private readonly trendTracker: TrendTracker,
    log: (msg: string) => void,
    private readonly scanScheduler?: ScanScheduler,
  ) {
    super();
    this._log = log;
    this.registerDisposable(this.manager.onDidUpdateAll((changed: vscode.Uri[]) => {
      this.diagEventCount++;
      this._log(`[VS-DIAG] onDidUpdateAll received ${changed.length} URIs (flushUpdates=${this.flushUpdates ? 'ready' : 'NOT_READY'})`);
      for (let i = 0; i < changed.length; i++) {
        this.pendingUris.add(changed[i].toString());
      }
      if (changed.length > 0) {
        if (this.flushUpdates) {
          this.flushUpdates();
        } else {
          this._log(`[VS-DIAG] WARNING: dropped ${changed.length} URIs — flushUpdates not initialized (start() not called?)`);
        }
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
    this._log('[VS-DIAG] onStart: initializing flushUpdates');
    this.flushUpdates = debounce(() => {
      this._log(`[VS-DIAG] flushUpdates firing: pending=${this.pendingUris.size} dirty=${this.dirtyUris.size}`);
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
        this._log(`[VS-DIAG] decorationEngine.fireDidChange: ${uris.length} URIs`);
        this.decorationEngine.fireDidChange(uris);
        // Forced full refresh fallback: targeted URI invalidation can be missed by VS Code
        // when the explorer has stale `undefined` cache for invisible/collapsed files.
        // Fire `undefined` 250ms later to nudge VS Code into re-querying ALL visible file
        // decorations. This is the insurance policy that makes badges appear reliably for
        // files the user hasn't yet clicked.
        setTimeout(() => {
          this.decorationEngine.fireDidChange(undefined);
          this._log('[VS-DIAG] decorationEngine.fireDidChange: undefined (fallback full refresh)');
        }, 250);
      } else {
        this._log('[VS-DIAG] flushUpdates: no dirty URIs to refresh');
      }
      this.statusBarManager.update();
      this.trendTracker.takeSnapshot();
    }, PROCESSING_DEBOUNCE_MS);

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      // Flush any URIs that were queued before flushUpdates was initialized (e.g., from initializeAll scans)
      if (this.pendingUris.size > 0) {
        this.flushUpdates();
        this.flushUpdates.flush();
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
    if (this.scanScheduler) {
      // Route through ScanScheduler instead of calling manager.refreshAll() directly
      void this.scanScheduler.submitAll('manual', 'vsdiagnostics refresh');
    } else {
      // Fallback for backward compatibility
      this.manager.refreshAll();
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
