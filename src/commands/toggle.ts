import { workspace } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { FolderStatusManager } from '../folder/folderStatusManager';

export function createToggleHandler(
  configManager: ConfigManager,
  decorationEngine: DecorationEngine,
  diagProvider: VSCodeDiagnosticProvider,
  folderStatusManager: FolderStatusManager,
): () => Promise<void> {
  return async () => {
    const config = configManager.getConfig();
    const newValue = !config.enabled;
    await workspace
      .getConfiguration('problemExplorer')
      .update('enabled', newValue, true);

    if (newValue) {
      diagProvider.fullScan();
      const changed = folderStatusManager.rebuildAll();
      decorationEngine.fireDidChange(changed);
    } else {
      decorationEngine.fireDidChange(undefined);
    }
  };
}
