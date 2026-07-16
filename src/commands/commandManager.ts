import { commands, ExtensionContext } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { TscDiagnosticProvider } from '../providers/TscDiagnosticProvider';
import { EslintDiagnosticProvider } from '../providers/EslintDiagnosticProvider';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { StatusBarManager } from '../statusBar/statusBarManager';
import { createRefreshHandler } from './refresh';
import { createToggleHandler } from './toggle';
import { createScanHandler } from './scan';
import { createScanAllHandler } from './scanAll';
import { COMMANDS } from '../core/constants';

export class CommandManager {
  constructor(
    private readonly diagProvider: VSCodeDiagnosticProvider,
    private readonly decorationEngine: DecorationEngine,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly configManager: ConfigManager,
    private readonly tscProvider?: TscDiagnosticProvider,
    private readonly eslintProvider?: EslintDiagnosticProvider,
    private readonly statusBarManager?: StatusBarManager,
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

    if (this.log) {
      context.subscriptions.push(
        commands.registerCommand(
          COMMANDS.SCAN_ALL,
          createScanAllHandler(
            this.tscProvider,
            this.eslintProvider,
            this.folderStatusManager,
            this.decorationEngine,
            this.statusBarManager!,
            this.log,
          ),
        ),
      );
    }

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
