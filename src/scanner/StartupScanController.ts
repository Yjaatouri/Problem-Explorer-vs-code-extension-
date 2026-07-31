import { Disposable, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { ScanScheduler } from './ScanScheduler';

/**
 * Runs one workspace-wide scan at extension startup using every provider
 * with `startupScan: true`. Non-blocking, cancellable, with status bar feedback.
 *
 * Flow:
 *   run() → ScanScheduler.routeStartup() → providers → ProblemStore
 *
 * The status bar item "Initial scan..." stays visible while the queued scan
 * runs and is hidden automatically when every provider that was submitted
 * fires its `phase: 'completed'` progress event (or after a 60s safety timeout).
 */
export class StartupScanController implements Disposable {
  private readonly scheduler: ScanScheduler;
  private readonly log: (msg: string) => void;
  private readonly statusItem: StatusBarItem;
  private progressSub: Disposable | undefined;
  private safetyTimer: ReturnType<typeof setTimeout> | undefined;

  /** Provider names we're still waiting on for completion. */
  private readonly pending = new Set<string>();

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
      this.finish();
      return;
    }

    this.pending.clear();
    for (const name of result.providerNames) {
      this.pending.add(name);
    }
    this.log(`[STARTUP-SCAN] Starting initial scan for: ${result.providerNames.join(', ')}`);
    this.statusItem.text = '$(sync~spin) Initial scan...';
    this.statusItem.show();

    // Subscribe to scan progress events to dismiss the spinner when done.
    this.progressSub = this.scheduler.manager.onDidScanProgress((progress) => {
      if (progress.phase === 'completed' || progress.phase === 'cancelled') {
        this.pending.delete(progress.providerName);
        this.log(`[STARTUP-SCAN] ${progress.providerName} ${progress.phase} (${this.pending.size} remaining)`);
        if (this.pending.size === 0) {
          this.finish();
        }
      }
    });

    // Safety net: dismiss after 60s even if some providers never report completion.
    this.safetyTimer = setTimeout(() => {
      if (this._running) {
        this.log(`[STARTUP-SCAN] Safety timeout — ${this.pending.size} providers never reported completion`);
        this.finish();
      }
    }, 60_000);
  }

  /** Cancel a running startup scan */
  cancel(): void {
    if (!this._running) return;
    this.log('[STARTUP-SCAN] Cancelling initial scan');
    this.scheduler.manager.stopAll();
    this.finish();
  }

  private finish(): void {
    this.progressSub?.dispose();
    this.progressSub = undefined;
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = undefined;
    }
    this.pending.clear();
    this.statusItem.hide();
    this._running = false;
  }

  dispose(): void {
    this.cancel();
    this.statusItem.dispose();
  }
}