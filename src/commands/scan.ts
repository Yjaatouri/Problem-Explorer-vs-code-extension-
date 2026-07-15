import { window } from 'vscode';
import { TscDiagnosticProvider } from '../providers/TscDiagnosticProvider';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';

export function createScanHandler(
  tscProvider: TscDiagnosticProvider,
  folderStatusManager: FolderStatusManager,
  decorationEngine: DecorationEngine,
  log: (msg: string) => void,
): () => Promise<void> {
  return async () => {
    const startTime = Date.now();
    log('[TSC-SCAN] Starting TypeScript scan...');
    try {
      await tscProvider.refresh();
      folderStatusManager.rebuildAll();
      decorationEngine.refresh();
      const elapsed = Date.now() - startTime;
      log(`[TSC-SCAN] Completed in ${elapsed}ms`);
      window.showInformationMessage(`TypeScript scan completed in ${elapsed}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[TSC-SCAN] Failed: ${msg}`);
      window.showErrorMessage(`TypeScript scan failed: ${msg}`);
    }
  };
}
