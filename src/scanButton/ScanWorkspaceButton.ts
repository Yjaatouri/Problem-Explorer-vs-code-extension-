import { commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import { ScanProgress } from '../core/types';

/**
 * Scan Workspace button for the status bar.
 *
 * - Shows a clickable status bar item with real-time scan progress
 * - Displays the current provider and phase while scanning
 * - Becomes inert while a scan is running
 * - Tracks scanning state via `problemExplorer.scanning` context key
 */
export class ScanWorkspaceButton implements Disposable {
  private readonly item: StatusBarItem;
  private readonly manager: DiagnosticProviderManager;
  private _scanning = false;
  private _progressTimer: ReturnType<typeof setTimeout> | undefined;

  static readonly COMMAND_ID = 'problemExplorer.runScanWorkspace';

  constructor(
    context: ExtensionContext,
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
  ) {
    this.manager = manager;
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 2);
    this.item.name = 'Problem Explorer Scan Workspace';
    this.item.text = '$(search) Scan Workspace';
    this.item.tooltip = 'Run a full workspace scan (tsc + ESLint)';
    this.item.command = ScanWorkspaceButton.COMMAND_ID;
    this.item.show();

    // Subscribe to real-time scan progress from the manager
    context.subscriptions.push(
      this.manager.onDidScanProgress((progress: ScanProgress) => {
        if (!this._scanning) return;
        this.updateProgressItem(progress);
      }),
    );

    context.subscriptions.push(
      commands.registerCommand(ScanWorkspaceButton.COMMAND_ID, async () => {
        if (this._scanning) {
          log('[SCAN-BUTTON] Scan already in progress — ignoring click');
          return;
        }

        this._scanning = true;
        this.item.text = '$(sync~spin) Starting...';
        this.item.tooltip = 'Workspace scan in progress';
        commands.executeCommand('setContext', 'problemExplorer.scanning', true);

        try {
          await commands.executeCommand('problemExplorer.scanWorkspace');
        } catch (e) {
          log(`[SCAN-BUTTON] Scan failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          this._scanning = false;
          this.item.text = '$(search) Scan Workspace';
          this.item.tooltip = 'Run a full workspace scan (tsc + ESLint)';
          commands.executeCommand('setContext', 'problemExplorer.scanning', false);

          // Briefly show completed state
          this.item.text = '$(check) Done';
          if (this._progressTimer) clearTimeout(this._progressTimer);
          this._progressTimer = setTimeout(() => {
            this.item.text = '$(search) Scan Workspace';
            this._progressTimer = undefined;
          }, 3000);
        }
      }),
    );

    context.subscriptions.push(this);
  }

  private updateProgressItem(progress: ScanProgress): void {
    const phaseIcon = progress.phase === 'completed' || progress.phase === 'writing'
      ? '$(check)'
      : progress.phase === 'cancelled' || progress.phase === 'error'
        ? '$(alert)'
        : '$(sync~spin)';

    const label = progress.message ?? progress.phase;
    this.item.text = `${phaseIcon} ${label}`;
    this.item.tooltip = `Scanning: ${progress.providerName} — ${progress.phase}${progress.detail ? ` (${progress.detail})` : ''}`;
  }

  dispose(): void {
    if (this._progressTimer) clearTimeout(this._progressTimer);
    this.item.dispose();
  }
}
