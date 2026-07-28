import { commands, ExtensionContext } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { ScanScheduler } from '../scanner/ScanScheduler';
import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { StatusBarManager } from '../statusBar/statusBarManager';
import { createRefreshHandler } from './refresh';
import { createToggleHandler } from './toggle';
import { createScanWorkspaceHandler } from './scanWorkspace';
import { COMMANDS } from '../core/constants';

export class CommandManager {
  constructor(
    private readonly diagProvider: VSCodeDiagnosticProvider,
    private readonly decorationEngine: DecorationEngine,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly configManager: ConfigManager,
    private readonly statusBarManager: StatusBarManager | undefined,
    private readonly log: ((msg: string) => void) | undefined,
    private readonly scheduler: ScanScheduler,
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

    if (this.log && this.statusBarManager) {
      context.subscriptions.push(
        commands.registerCommand(
          COMMANDS.SCAN_WORKSPACE,
          createScanWorkspaceHandler(
            this.scheduler,
            this.folderStatusManager,
            this.decorationEngine,
            this.statusBarManager,
            this.log,
          ),
        ),
      );
    }
  }
}
