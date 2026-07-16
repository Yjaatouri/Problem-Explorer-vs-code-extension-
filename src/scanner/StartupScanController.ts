import { Disposable, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';

/**
 * Runs one workspace-wide scan at extension startup using every provider
 * with `startupScan: true`. Non-blocking, cancellable, with status bar feedback.
 *
 * Flow:
 *   run() → DiagnosticProviderManager.refreshByNames() → providers → ProblemStore
 */
export class StartupScanController implements Disposable {
  private readonly manager: DiagnosticProviderManager;
  private readonly log: (msg: string) => void;
  private readonly statusItem: StatusBarItem;

  /** Called with each candidate provider name; return true to skip it */
  private readonly skipProvider?: (name: string) => boolean;

  private _running = false;
  private _cancelled = false;

  constructor(
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
    skipProvider?: (name: string) => boolean,
  ) {
    this.manager = manager;
    this.log = log;
    this.skipProvider = skipProvider;
    this.statusItem = window.createStatusBarItem(StatusBarAlignment.Left, 0);
    this.statusItem.name = 'Problem Explorer Startup Scan';
    this.statusItem.text = '$(sync~spin) Initial scan...';
    this.statusItem.tooltip = 'Problem Explorer is scanning the workspace';
    this.statusItem.hide();
  }

  /** Kick off the startup scan. Returns immediately (non-blocking). */
  run(): void {
    if (this._running) {
      this.log('[STARTUP-SCAN] Already running, skipping duplicate');
      return;
    }
    this._running = true;
    this._cancelled = false;

    const candidates: string[] = [];
    for (const info of this.manager.all()) {
      if (!info.provider.capabilities.startupScan) continue;
      if (!info.provider.enabled) continue;
      if (this.skipProvider?.(info.name)) continue;
      candidates.push(info.name);
    }

    if (candidates.length === 0) {
      this.log('[STARTUP-SCAN] No providers with startupScan enabled');
      this._running = false;
      return;
    }

    this.log(`[STARTUP-SCAN] Starting initial scan for: ${candidates.join(', ')}`);
    this.statusItem.text = '$(sync~spin) Initial scan...';
    this.statusItem.show();

    // Fire-and-forget: run async but don't block activation
    this.execute(candidates);
  }

  /** Cancel a running startup scan */
  cancel(): void {
    if (!this._running) return;
    this._cancelled = true;
    this.log('[STARTUP-SCAN] Cancelling initial scan');
    this.manager.stopAll();
    this.statusItem.hide();
    this._running = false;
  }

  dispose(): void {
    this.cancel();
    this.statusItem.dispose();
  }

  private async execute(names: string[]): Promise<void> {
    try {
      await this.manager.refreshByNames(names);
      if (!this._cancelled) {
        this.log('[STARTUP-SCAN] Initial scan completed');
      }
    } catch (e) {
      if (!this._cancelled) {
        this.log(`[STARTUP-SCAN] Initial scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      this.statusItem.hide();
      this._running = false;
    }
  }
}
