import { Disposable, Uri, workspace } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import { StatusBarManager } from '../statusBar/statusBarManager';

export class AutoScanController implements Disposable {
  private readonly disposables: Disposable[] = [];
  private readonly manager: DiagnosticProviderManager;
  private readonly statusBar: StatusBarManager;
  private readonly log: (msg: string) => void;
  private readonly queuedProviders = new Set<string>();
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _debounceMs: number;
  private _enabled = true;
  private _flushing = false;

  constructor(
    manager: DiagnosticProviderManager,
    statusBar: StatusBarManager,
    log: (msg: string) => void,
    debounceMs: number = 300,
    enabled: boolean = true,
  ) {
    this.manager = manager;
    this.statusBar = statusBar;
    this.log = log;
    this._debounceMs = debounceMs;
    this._enabled = enabled;
  }

  start(): void {
    this.disposables.push(
      workspace.onDidSaveTextDocument((doc) => {
        this.onFileChanged(doc.uri);
      }),
      workspace.onDidCreateFiles((e) => {
        for (const uri of e.files) {
          this.onFileChanged(uri);
        }
      }),
      workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          this.onFileChanged(uri);
        }
      }),
      workspace.onDidRenameFiles((e) => {
        for (const { newUri } of e.files) {
          this.onFileChanged(newUri);
        }
      }),
    );
  }

  updateConfig(debounceMs: number, enabled: boolean): void {
    this._debounceMs = debounceMs;
    this._enabled = enabled;
  }

  private onFileChanged(uri: Uri): void {
    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));

    if (!this._enabled) {
      return;
    }

    const ownerName = this.manager.getOwner(ext);
    if (!ownerName) {
      return;
    }

    this.queuedProviders.add(ownerName);
    this._schedule();
  }

  private _schedule(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    } else if (!this._flushing) {
      this._cancelActiveScans();
    } else {
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
        try {
          provider.stop();
        } catch (err) {
          this.log(`[AUTO-SCAN] Error stopping ${providerName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private async _flush(_callerTs?: number): Promise<void> {
    if (this.queuedProviders.size === 0) {
      return;
    }
    if (this._flushing) {
      return;
    }
    this._flushing = true;

    const names = Array.from(this.queuedProviders);
    this.queuedProviders.clear();

    this.statusBar.setScanning(true, names[0]);

    const promises: Promise<void>[] = [];

    for (const name of names) {
      const provider = this.manager.get(name);
      if (!provider) {
        continue;
      }

      this.log(`[AUTO-SCAN] Triggering ${name} auto-scan...`);
      const result = provider.refresh();
      if (result instanceof Promise) {
        promises.push(
          result.then(() => {
            this.log(`[AUTO-SCAN] ${name} scan completed`);
            this.log(`[VERIFY] Store entries after auto-scan (${name}): ${provider.store.size()}`);
          }).catch((err: Error) => {
            this.log(`[AUTO-SCAN] ${name} scan failed: ${err.message ?? String(err)}`);
          }),
        );
      } else {
        this.log(`[AUTO-SCAN] ${name} scan completed`);
        this.log(`[VERIFY] Store entries after auto-scan (${name}): ${provider.store.size()}`);
      }
    }

    try {
      await Promise.all(promises);
    } finally {
      this.statusBar.setScanning(false);
      this._flushing = false;
      if (this.queuedProviders.size > 0) {
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = undefined;
          this._flush();
        }, this._debounceMs);
      }
    }
  }

  dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
