import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { DecorationEngine } from '../decoration/decorationEngine';
import { FolderStatusManager } from '../folder/folderStatusManager';

export function createRefreshHandler(
  diagProvider: VSCodeDiagnosticProvider,
  decorationEngine: DecorationEngine,
  folderStatusManager: FolderStatusManager,
): () => void {
  return () => {
    diagProvider.fullScan();
    folderStatusManager.rebuildAll();
    decorationEngine.refresh();
  };
}
