import * as vscode from 'vscode';
import { DiagnosticsManager } from '../diagnostics/diagnosticsManager';
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
    private readonly diagnosticsManager: DiagnosticsManager,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly apiManager: ApiManager,
    private readonly decorationEngine: DecorationEngine,
    private readonly statusBarManager: StatusBarManager,
    private readonly trendTracker: TrendTracker,
    private readonly log: (msg: string) => void,
  ) {
    super();
  }

  markPending(uri: vscode.Uri): void {
    this.pendingUris.add(uri.toString());
  }

  flush(): void {
    this.flushUpdates?.();
  }

  protected onStart(): void {
    const notifyApi = (uris: vscode.Uri[]): void => {
      for (let i = 0; i < uris.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(uris[i]);
        if (folder) {
          this.apiManager.notifyChanged(uris[i], folder.uri);
        }
      }
    };

    this.flushUpdates = debounce(() => {
      this.log(`[FORENSIC:Step4-prep] flushUpdates: pending=${this.pendingUris.size}`);
      for (const uriStr of this.pendingUris) {
        const uri = vscode.Uri.parse(uriStr);
        this.dirtyUris.add(uriStr);
        const ancestors = this.folderStatusManager.updateAncestors(uri);
        notifyApi(ancestors);
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

    const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
      this.diagEventCount++;
      this.log(`[FORENSIC:Step1] onDidChangeDiagnostics #${this.diagEventCount}: ${e.uris.length} URIs`);
      for (let di = 0; di < Math.min(e.uris.length, 10); di++) {
        this.log(`[FORENSIC:Step1]   URI[${di}]=${e.uris[di].toString(true)}`);
        const ddx = vscode.languages.getDiagnostics(e.uris[di]);
        this.log(`[FORENSIC:Step1]   URI[${di}] diagCount=${ddx.length}`);
      }
      if (e.uris.length > 10) {
        this.log(`[FORENSIC:Step1]   ... and ${e.uris.length - 10} more URIs`);
      }
      const changed = this.diagnosticsManager.processChanges(e);
      this.log(`[FORENSIC:Step2] processChanges returned ${changed.length} changed URIs`);
      const severityCounts = this.diagnosticsManager.getEventDiagnosticsCounts(e);
      for (const sc of severityCounts) {
        this.log(`[FORENSIC:Step2]   URI=${sc.uri} err=${sc.err} warn=${sc.warn} info=${sc.info} hint=${sc.hint}`);
      }
      notifyApi(changed);
      for (let i = 0; i < changed.length; i++) {
        this.pendingUris.add(changed[i].toString());
      }
      if (changed.length > 0) {
        this.flushUpdates?.();
      }
    });

    this.registerDisposable(disposable);
    this.registerDisposable({ dispose: () => this.flushUpdates?.cancel() });
  }

  protected onRefresh(): void {
    // TODO: full re-scan of all diagnostics
  }
}
