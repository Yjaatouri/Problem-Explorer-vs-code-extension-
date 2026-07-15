import { commands, ExtensionContext } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { TscDiagnosticProvider } from '../providers/TscDiagnosticProvider';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { createRefreshHandler } from './refresh';
import { createToggleHandler } from './toggle';
import { createScanHandler } from './scan';
import { COMMANDS } from '../core/constants';

export class CommandManager {
  constructor(
    private readonly diagProvider: VSCodeDiagnosticProvider,
    private readonly decorationEngine: DecorationEngine,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly configManager: ConfigManager,
    private readonly tscProvider?: TscDiagnosticProvider,
    private readonly log?: (msg: string) => void,
  ) {}

  register(context: ExtensionContext): void {
    context.subscriptions.push(
      commands.registerCommand(
        COMMANDS.REFRESH,
        createRefreshHandler(
          this.diagProvider,
          this.decorationEngine,
          this.folderStatusManager,
        ),
      ),
    );

    context.subscriptions.push(
      commands.registerCommand(
        COMMANDS.TOGGLE,
        createToggleHandler(
          this.configManager,
          this.decorationEngine,
          this.diagProvider,
          this.folderStatusManager,
        ),
      ),
    );

    if (this.tscProvider && this.log) {
      context.subscriptions.push(
        commands.registerCommand(
          COMMANDS.SCAN_TS,
          createScanHandler(
            this.tscProvider,
            this.folderStatusManager,
            this.decorationEngine,
            this.log,
          ),
        ),
      );

      context.subscriptions.push(
        commands.registerCommand(COMMANDS.CANCEL_SCAN, () => {
          this.log?.('[CANCEL_SCAN] Cancelling TypeScript scan...');
          this.tscProvider!.stop();
        }),
      );
    }
  }
}
