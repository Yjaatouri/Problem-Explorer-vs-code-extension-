import { commands, ExtensionContext } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { createRefreshHandler } from './refresh';
import { createToggleHandler } from './toggle';
import { COMMANDS } from '../core/constants';

export class CommandManager {
  constructor(
    private readonly diagProvider: VSCodeDiagnosticProvider,
    private readonly decorationEngine: DecorationEngine,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly configManager: ConfigManager,
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
  }
}
