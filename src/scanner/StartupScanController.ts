import { Disposable, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { ScanScheduler } from './ScanScheduler';

/**
 * Runs one workspace-wide scan at extension startup using every provider
 * with `startupScan: true`. Non-blocking, cancellable, with status bar feedback.
 *
 * Flow:
 *   run() → ScanScheduler.routeStartup() → providers → ProblemStore
 */
export class StartupScanController implements Disposable {
  private readonly scheduler: ScanScheduler;
  private readonly log: (msg: string) => void;
  private readonly statusItem: StatusBarItem;

  private _running = false;

  constructor(
    scheduler: ScanScheduler,
    log: (msg: string) => void,
  ) {
    this.scheduler = scheduler;
    this.log = log;
    this.statusItem = window.createStatusBarItem(StatusBarAlignment.Left, 0);
    this.statusItem.name = 'Problem Explorer Startup Scan';
    this.statusItem.text = '$(sync~spin) Initial scan...';
    this.statusItem.tooltip = 'Problem Explorer is scanning the workspace';
    this.statusItem.hide();
  }

  /** Kick off the startup scan. Returns immediately (non-blocking). */
  async run(): Promise<void> {
    if (this._running) {
      this.log('[STARTUP-SCAN] Already running, skipping duplicate');
      return;
    }
    this._running = true;

    const result = await this.scheduler.routeStartup();
    if (!result.submitted) {
      this.log(`[STARTUP-SCAN] ${result.skipReason}`);
      this._running = false;
      return;
    }

    this.log(`[STARTUP-SCAN] Starting initial scan for: ${result.providerNames.join(', ')}`);
    this.statusItem.text = '$(sync~spin) Initial scan...';
    this.statusItem.show();
  }

  /** Cancel a running startup scan */
  cancel(): void {
    if (!this._running) return;
    this.log('[STARTUP-SCAN] Cancelling initial scan');
    this.scheduler.manager.stopAll();
    this.statusItem.hide();
    this._running = false;
  }

  dispose(): void {
    this.cancel();
    this.statusItem.dispose();
  }
}