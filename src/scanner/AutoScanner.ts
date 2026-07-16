import { Disposable, StatusBarAlignment, StatusBarItem, Uri, window, workspace } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import { AUTO_SCAN_EXTENSIONS_TSC, AUTO_SCAN_EXTENSIONS_ESLINT } from '../core/constants';
import { chainCounters } from '../forensicLogger';

interface ScanTarget {
  providerName: string;
  extensions: readonly string[];
}

const SCAN_TARGETS: ScanTarget[] = [
  { providerName: 'tsc', extensions: AUTO_SCAN_EXTENSIONS_TSC },
  { providerName: 'eslint', extensions: AUTO_SCAN_EXTENSIONS_ESLINT },
];

export class AutoScanner implements Disposable {
  private readonly disposables: Disposable[] = [];
  private readonly statusItem: StatusBarItem;
  private readonly manager: DiagnosticProviderManager;
  private readonly log: (msg: string) => void;
  private readonly queuedProviders = new Set<string>();
  private _activeScans = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _debounceMs: number;
  private _enabled = true;

  constructor(
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
    debounceMs: number = 2000,
    enabled: boolean = true,
  ) {
    this.manager = manager;
    this.log = log;
    this._debounceMs = debounceMs;
    this._enabled = enabled;
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

  updateConfig(debounceMs: number, enabled: boolean): void {
    this._debounceMs = debounceMs;
    this._enabled = enabled;
  }

  private onFileChanged(uri: Uri): void {
    if (!this._enabled) return;

    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));

    for (const target of SCAN_TARGETS) {
      if (!target.extensions.includes(ext)) continue;
      const provider = this.manager.get(target.providerName);
      if (!provider || !provider.enabled || !provider.autoScan) continue;
      this.queuedProviders.add(target.providerName);
      chainCounters.autoScannerTriggered++;
    }

    if (this.queuedProviders.size === 0) return;
    this._schedule();
  }

  private _schedule(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    } else {
      this._cancelActiveScans();
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      this._flush();
    }, this._debounceMs);
  }

  private _cancelActiveScans(): void {
    for (const target of SCAN_TARGETS) {
      const provider = this.manager.get(target.providerName);
      if (provider?.scanning) {
        this.log(`[AUTO-SCAN] Cancelling in-progress ${target.providerName} scan`);
        provider.stop();
      }
    }
  }

  private async _flush(): Promise<void> {
    if (this.queuedProviders.size === 0) return;
    chainCounters.autoScannerFlushCalled++;

    const names = Array.from(this.queuedProviders);
    this.queuedProviders.clear();

    this._updateStatus(true);

    const promises: Promise<void>[] = [];

    for (const name of names) {
      const provider = this.manager.get(name);
      if (!provider) continue;
      chainCounters.autoScannerFlushProviderRun++;

      this.log(`[AUTO-SCAN] Triggering ${name} auto-scan...`);
      const result = provider.refresh();
      if (result instanceof Promise) {
        promises.push(
          result.then(() => {
            this.log(`[AUTO-SCAN] ${name} scan completed`);
            this.log(`[VERIFY] Store entries after auto-scan (${name}): ${provider.store.size()}`);
          }),
        );
      } else {
        this.log(`[AUTO-SCAN] ${name} scan completed`);
        this.log(`[VERIFY] Store entries after auto-scan (${name}): ${provider.store.size()}`);
      }
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
