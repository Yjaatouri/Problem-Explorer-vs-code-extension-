import { DiagnosticsManager } from '../diagnostics/diagnosticsManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';

export function createRefreshHandler(
  diagnosticsManager: DiagnosticsManager,
  decorationEngine: DecorationEngine,
  folderStatusManager: FolderStatusManager,
): () => void {
  return () => {
    diagnosticsManager.fullScan();
    folderStatusManager.rebuildAll();
    decorationEngine.refresh();
  };
}
