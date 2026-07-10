import { commands, ExtensionContext } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { DiagnosticsManager } from '../diagnostics/diagnosticsManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { createRefreshHandler } from './refresh';
import { createToggleHandler } from './toggle';
import { COMMANDS } from '../core/constants';

/** Registers all extension commands (`problemExplorer.refresh`, `problemExplorer.toggle`) */
export class CommandManager {
  constructor(
    private readonly diagnosticsManager: DiagnosticsManager,
    private readonly decorationEngine: DecorationEngine,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly configManager: ConfigManager,
  ) {}

  /** Register all commands into the given extension context */
  register(context: ExtensionContext): void {
    context.subscriptions.push(
      commands.registerCommand(
        COMMANDS.REFRESH,
        createRefreshHandler(
          this.diagnosticsManager,
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
          this.diagnosticsManager,
          this.folderStatusManager,
        ),
      ),
    );
  }
}
