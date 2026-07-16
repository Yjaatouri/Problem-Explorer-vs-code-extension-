import { Disposable, StatusBarAlignment, StatusBarItem, Uri, window, workspace } from 'vscode';
import { TscDiagnosticProvider } from '../providers/TscDiagnosticProvider';
import { EslintDiagnosticProvider } from '../providers/EslintDiagnosticProvider';
import { AUTO_SCAN_DEBOUNCE_MS, AUTO_SCAN_EXTENSIONS_TSC, AUTO_SCAN_EXTENSIONS_ESLINT } from '../core/constants';

export class AutoScanner implements Disposable {
  private readonly disposables: Disposable[] = [];
  private readonly statusItem: StatusBarItem;
  private _tscQueued = false;
  private _eslintQueued = false;
  private _activeScans = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tscProvider: TscDiagnosticProvider | undefined,
    private readonly eslintProvider: EslintDiagnosticProvider | undefined,
    private readonly log: (msg: string) => void,
  ) {
    this.statusItem = window.createStatusBarItem(StatusBarAlignment.Left, 1);
    this.statusItem.name = 'Problem Explorer Auto-Scan';
    this.statusItem.text = '$(sync~spin) Scanning...';
    this.statusItem.tooltip = 'Auto-scan in progress';
    this.statusItem.hide();
  }

  start(): void {
    this.disposables.push(
      workspace.onDidSaveTextDocument((doc) => this.onFileChanged(doc.uri)),
      workspace.onDidCreateFiles((e) => {
        for (const uri of e.files) this.onFileChanged(uri);
      }),
      workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) this.onFileChanged(uri);
      }),
      workspace.onDidRenameFiles((e) => {
        for (const { newUri } of e.files) this.onFileChanged(newUri);
      }),
    );
  }

  private onFileChanged(uri: Uri): void {
    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));
    const needsTsc = this.tscProvider?.enabled && this.tscProvider?.autoScan && AUTO_SCAN_EXTENSIONS_TSC.includes(ext);
    const needsEslint = this.eslintProvider?.enabled && this.eslintProvider?.autoScan && AUTO_SCAN_EXTENSIONS_ESLINT.includes(ext);

    if (!needsTsc && !needsEslint) return;

    if (needsTsc) this._tscQueued = true;
    if (needsEslint) this._eslintQueued = true;

    this._schedule();
  }

  private _schedule(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      this._flush();
    }, AUTO_SCAN_DEBOUNCE_MS);
  }

  private async _flush(): Promise<void> {
    const runTsc = this._tscQueued;
    const runEslint = this._eslintQueued;
    this._tscQueued = false;
    this._eslintQueued = false;

    if (!runTsc && !runEslint) return;

    this._updateStatus(true);

    const promises: Promise<void>[] = [];

    if (runTsc && this.tscProvider) {
      this.log('[AUTO-SCAN] Triggering tsc auto-scan...');
      promises.push(
        this.tscProvider.refresh().then(() => {
          this.log('[AUTO-SCAN] tsc scan completed');
        }),
      );
    }

    if (runEslint && this.eslintProvider) {
      this.log('[AUTO-SCAN] Triggering eslint auto-scan...');
      promises.push(
        this.eslintProvider.refresh().then(() => {
          this.log('[AUTO-SCAN] eslint scan completed');
        }),
      );
    }

    await Promise.all(promises);
    this._updateStatus(false);
  }

  private _updateStatus(active: boolean): void {
    if (active) {
      this._activeScans++;
      this.statusItem.text = '$(sync~spin) Scanning...';
      this.statusItem.show();
    } else {
      this._activeScans--;
      if (this._activeScans <= 0) {
        this._activeScans = 0;
        this.statusItem.hide();
      }
    }
  }

  dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this.statusItem.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
