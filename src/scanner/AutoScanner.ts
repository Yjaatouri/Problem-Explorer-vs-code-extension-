import { Disposable, StatusBarAlignment, StatusBarItem, Uri, window, workspace } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import { chainCounters } from '../forensicLogger';

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
  private _flushing = false;

  constructor(
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
    debounceMs: number = 300,
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
        const ts = Date.now();
        console.log(`[AUDIT:${ts}] Step1: onDidSaveTextDocument uri=${doc.uri.fsPath}`);
        this.onFileChanged(doc.uri);
        console.log(`[AUDIT:${Date.now()}] Step1: onDidSaveTextDocument EXIT elapsed=${Date.now() - ts}ms`);
      }),
      workspace.onDidCreateFiles((e) => {
        const ts = Date.now();
        for (const uri of e.files) {
          console.log(`[AUDIT:${ts}] Step1: onDidCreateFiles uri=${uri.fsPath}`);
          this.onFileChanged(uri);
        }
      }),
      workspace.onDidDeleteFiles((e) => {
        const ts = Date.now();
        for (const uri of e.files) {
          console.log(`[AUDIT:${ts}] Step1: onDidDeleteFiles uri=${uri.fsPath}`);
          this.onFileChanged(uri);
        }
      }),
      workspace.onDidRenameFiles((e) => {
        const ts = Date.now();
        for (const { newUri } of e.files) {
          console.log(`[AUDIT:${ts}] Step1: onDidRenameFiles uri=${newUri.fsPath}`);
          this.onFileChanged(newUri);
        }
      }),
    );
  }

  updateConfig(debounceMs: number, enabled: boolean): void {
    const ts = Date.now();
    this._debounceMs = debounceMs;
    this._enabled = enabled;
    console.log(`[AUDIT:${ts}] updateConfig debounceMs=${debounceMs} enabled=${enabled}`);
  }

  private onFileChanged(uri: Uri): void {
    const ts = Date.now();
    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));
    console.log(`[AUDIT:${ts}] Step2: onFileChanged uri=${uri.fsPath} ext=${ext} _enabled=${this._enabled} queued=[${Array.from(this.queuedProviders).join(',')}]`);

    if (!this._enabled) {
      console.log(`[AUDIT:${ts}] Step2: EARLY RETURN — auto-scan disabled _enabled=false`);
      return;
    }

    const ownerName = this.manager.getOwner(ext);
    console.log(`[AUDIT:${ts}] Step2: getOwner("${ext}") → ${ownerName ?? '(undefined)'}`);
    if (!ownerName) {
      console.log(`[AUDIT:${ts}] Step2: EARLY RETURN — no provider owns extension "${ext}"`);
      return;
    }

    this.queuedProviders.add(ownerName);
    chainCounters.autoScannerTriggered++;
    console.log(`[AUDIT:${ts}] Step2: queued provider="${ownerName}" queued=[${Array.from(this.queuedProviders).join(',')}]`);
    this._schedule(ts);
    console.log(`[AUDIT:${Date.now()}] Step2: onFileChanged EXIT elapsed=${Date.now() - ts}ms`);
  }

  private _schedule(callerTs?: number): void {
    const ts = callerTs ?? Date.now();
    const hasTimer = this._debounceTimer !== undefined;
    console.log(`[AUDIT:${ts}] Step3: _schedule _debounceTimer=${hasTimer} _flushing=${this._flushing} queued=[${Array.from(this.queuedProviders).join(',')}]`);

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      console.log(`[AUDIT:${ts}] Step3: cleared existing debounce timer`);
    } else if (!this._flushing) {
      console.log(`[AUDIT:${ts}] Step3: no active timer and not flushing — calling _cancelActiveScans`);
      this._cancelActiveScans(ts);
    } else {
      console.log(`[AUDIT:${ts}] Step3: no active timer BUT _flushing=true — skipping _cancelActiveScans`);
    }

    console.log(`[AUDIT:${ts}] Step3: setting debounce timer for ${this._debounceMs}ms`);
    this._debounceTimer = setTimeout(() => {
      const fireTs = Date.now();
      console.log(`[AUDIT:${fireTs}] Step3: debounce timer FIRED (after ${fireTs - ts}ms)`);
      this._debounceTimer = undefined;
      this._flush(fireTs);
    }, this._debounceMs);
    console.log(`[AUDIT:${Date.now()}] Step3: _schedule EXIT elapsed=${Date.now() - ts}ms`);
  }

  private _cancelActiveScans(callerTs?: number): void {
    const ts = callerTs ?? Date.now();
    console.log(`[AUDIT:${ts}] Step3a: _cancelActiveScans queued=[${Array.from(this.queuedProviders).join(',')}]`);
    for (const providerName of this.queuedProviders) {
      const provider = this.manager.get(providerName);
      const isScanning = provider?.scanning ?? false;
      console.log(`[AUDIT:${ts}] Step3a: provider="${providerName}" exists=${provider !== undefined} scanning=${isScanning}`);
      if (provider?.scanning) {
        this.log(`[AUTO-SCAN] Cancelling in-progress ${providerName} scan`);
        provider.stop();
      }
    }
  }

  private async _flush(callerTs?: number): Promise<void> {
    const ts = callerTs ?? Date.now();
    console.log(`[AUDIT:${ts}] Step4: _flush ENTER queueSize=${this.queuedProviders.size} _flushing=${this._flushing}`);

    if (this.queuedProviders.size === 0) {
      console.log(`[AUDIT:${ts}] Step4: EARLY RETURN — queuedProviders is empty`);
      return;
    }
    if (this._flushing) {
      console.log(`[AUDIT:${ts}] Step4: EARLY RETURN — already flushing, queued providers WILL BE DROPPED: [${Array.from(this.queuedProviders).join(',')}]`);
      return;
    }
    this._flushing = true;
    chainCounters.autoScannerFlushCalled++;

    const names = Array.from(this.queuedProviders);
    this.queuedProviders.clear();
    console.log(`[AUDIT:${ts}] Step4: captured providers=[${names.join(',')}] queue cleared`);

    this._updateStatus(true);

    const promises: Promise<void>[] = [];

    for (const name of names) {
      const provider = this.manager.get(name);
      console.log(`[AUDIT:${ts}] Step4: refresh provider="${name}" exists=${provider !== undefined}`);
      if (!provider) {
        console.log(`[AUDIT:${ts}] Step4: SKIP — provider "${name}" not found in manager`);
        continue;
      }
      chainCounters.autoScannerFlushProviderRun++;

      this.log(`[AUTO-SCAN] Triggering ${name} auto-scan...`);
      const result = provider.refresh();
      if (result instanceof Promise) {
        promises.push(
          result.then(() => {
            const endTs = Date.now();
            console.log(`[AUDIT:${endTs}] Step4: ${name} scan completed`);
            this.log(`[AUTO-SCAN] ${name} scan completed`);
            this.log(`[VERIFY] Store entries after auto-scan (${name}): ${provider.store.size()}`);
          }).catch((err: Error) => {
            const errTs = Date.now();
            console.log(`[AUDIT:${errTs}] Step4: ${name} scan FAILED: ${err.message ?? String(err)}`);
            this.log(`[AUTO-SCAN] ${name} scan failed: ${err.message ?? String(err)}`);
          }),
        );
      } else {
        console.log(`[AUDIT:${ts}] Step4: ${name} refresh returned synchronously`);
        this.log(`[AUTO-SCAN] ${name} scan completed`);
        this.log(`[VERIFY] Store entries after auto-scan (${name}): ${provider.store.size()}`);
      }
    }

    try {
      console.log(`[AUDIT:${ts}] Step4: awaiting ${promises.length} refresh promises...`);
      await Promise.all(promises);
    } finally {
      this._updateStatus(false);
      this._flushing = false;
      const elapsed = Date.now() - ts;
      console.log(`[AUDIT:${Date.now()}] Step4: flush complete, _flushing=false queued=[${Array.from(this.queuedProviders).join(',')}] elapsed=${elapsed}ms`);
      if (this.queuedProviders.size > 0) {
        console.log(`[AUDIT:${Date.now()}] Step4: re-scheduling flush for ${this.queuedProviders.size} queued providers`);
        this._debounceTimer = setTimeout(() => {
          const reTs = Date.now();
          this._debounceTimer = undefined;
          this._flush(reTs);
        }, this._debounceMs);
      }
    }
    console.log(`[AUDIT:${Date.now()}] Step4: _flush EXIT elapsed=${Date.now() - ts}ms`);
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
