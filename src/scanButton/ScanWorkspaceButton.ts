import { commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, window } from 'vscode';

/**
 * Scan Workspace button for the status bar.
 *
 * - Shows a clickable status bar item
 * - While a scan is running the text switches to a spinner and the button becomes inert
 * - Tracks scanning state via a context key (`problemExplorer.scanning`) so other UI
 *   elements (e.g. the explorer/title button) can react to it
 */
export class ScanWorkspaceButton implements Disposable {
  private readonly item: StatusBarItem;
  private _scanning = false;

  /** Command ID exposed so package.json menus can reference it too */
  static readonly COMMAND_ID = 'problemExplorer.runScanWorkspace';

  constructor(context: ExtensionContext, log: (msg: string) => void) {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 2);
    this.item.name = 'Problem Explorer Scan Workspace';
    this.item.text = '$(search) Scan Workspace';
    this.item.tooltip = 'Run a full workspace scan (tsc + ESLint)';
    this.item.command = ScanWorkspaceButton.COMMAND_ID;
    this.item.show();

    context.subscriptions.push(
      commands.registerCommand(ScanWorkspaceButton.COMMAND_ID, async () => {
        if (this._scanning) {
          log('[SCAN-BUTTON] Scan already in progress — ignoring click');
          return;
        }

        this._scanning = true;
        this.updateItem();
        commands.executeCommand('setContext', 'problemExplorer.scanning', true);

        try {
          await commands.executeCommand('problemExplorer.scanWorkspace');
        } catch (e) {
          log(`[SCAN-BUTTON] Scan failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          this._scanning = false;
          this.updateItem();
          commands.executeCommand('setContext', 'problemExplorer.scanning', false);
        }
      }),
    );

    context.subscriptions.push(this);
  }

  private updateItem(): void {
    if (this._scanning) {
      this.item.text = '$(sync~spin) Scanning...';
      this.item.tooltip = 'Workspace scan in progress';
    } else {
      this.item.text = '$(search) Scan Workspace';
      this.item.tooltip = 'Run a full workspace scan (tsc + ESLint)';
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
