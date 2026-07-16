import { Disposable, StatusBarAlignment, StatusBarItem, Uri, window, workspace } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../providers/DiagnosticProvider';
import { chainCounters } from '../forensicLogger';

/**
 * AutoScanController matches file-change events to providers by their
 * declared capabilities, then refreshes only matching scan providers.
 *
 * Providers never decide when to scan — the controller does.
 * Providers only answer the question: "Scan now."
 */
export class AutoScanController implements Disposable {
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
      workspace.onDidSaveTextDocument((doc) => {
        console.log(`[LOG:SAVE] Step1: onDidSaveTextDocument uri=${doc.uri.fsPath}`);
        this.onFileChanged(doc.uri);
      }),
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
    console.log(`[LOG:SAVE] Step2: AutoScanController.onFileChanged uri=${uri.fsPath}`);
    if (!this._enabled) {
      console.log(`[LOG:SAVE] Step2: auto-scan disabled, returning`);
      return;
    }

    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));
    console.log(`[LOG:SAVE] Step2: ext=${ext}`);

    const candidates = this.findScanProviders(ext);
    console.log(`[LOG:SAVE] Step2: ${candidates.length} candidate(s) for ext ${ext}`);

    for (const provider of candidates) {
      this.queuedProviders.add(provider.name);
      chainCounters.autoScannerTriggered++;
      console.log(`[LOG:SAVE] Step2: queued ${provider.name} for scan`);
    }

    if (this.queuedProviders.size === 0) {
      console.log(`[LOG:SAVE] Step2: no providers queued for ext ${ext}`);
      return;
    }
    this._schedule();
  }

  /**
   * Find all registered providers whose capabilities match the given extension.
   * - Provider must be enabled and support onSave scanning
   * - Provider's extensions list must include the file extension
   * - Realtime providers are excluded (they push on their own)
   */
  private findScanProviders(ext: string): DiagnosticProvider[] {
    const matches: DiagnosticProvider[] = [];
    for (const info of this.manager.all()) {
      const caps = info.provider.capabilities;
      if (!caps.onSave || !info.provider.enabled || !info.provider.autoScan) {
        console.log(`[LOG:SAVE] Step2: ${info.name} skipped (onSave=${caps.onSave} enabled=${info.provider.enabled} autoScan=${info.provider.autoScan})`);
        continue;
      }
      if (caps.realtime) {
        console.log(`[LOG:SAVE] Step2: ${info.name} skipped (realtime — pushes independently)`);
        continue;
      }
      if (!caps.extensions.includes(ext)) {
        console.log(`[LOG:SAVE] Step2: ${info.name} skipped (ext ${ext} not in [${caps.extensions.join(',')}])`);
        continue;
      }
      matches.push(info.provider);
    }
    return matches;
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
    for (const providerName of this.queuedProviders) {
      const provider = this.manager.get(providerName);
      if (provider?.scanning) {
        this.log(`[AUTO-SCAN] Cancelling in-progress ${providerName} scan`);
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
