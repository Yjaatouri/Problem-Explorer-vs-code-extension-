import { workspace } from 'vscode';
import { ConfigManager } from '../config/configManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { DiagnosticsManager } from '../diagnostics/diagnosticsManager';
import { FolderStatusManager } from '../folder/folderStatusManager';

export function createToggleHandler(
  configManager: ConfigManager,
  decorationEngine: DecorationEngine,
  diagnosticsManager: DiagnosticsManager,
  folderStatusManager: FolderStatusManager,
): () => Promise<void> {
  return async () => {
    const config = configManager.getConfig();
    const newValue = !config.enabled;
    // Await so ConfigManager (and DecorationEngine via setConfig) observe the
    // new value before decorations are re-queried.
    await workspace
      .getConfiguration('problemExplorer')
      .update('enabled', newValue, true);

    if (newValue) {
      diagnosticsManager.fullScan();
      folderStatusManager.rebuildAll();
    }
    decorationEngine.refresh();
  };
}
