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
    log('[TSC-SCAN] Starting TypeScript scan...');
    const startTime = Date.now();
    try {
      await tscProvider.refresh();
      folderStatusManager.rebuildAll();
      decorationEngine.refresh();
      const elapsed = Date.now() - startTime;
      const timing = tscProvider.lastScanTiming;

      if (timing) {
        log(
          `[TSC-SCAN] Timing: total=${timing.totalMs.toFixed(0)}ms ` +
          `(resolve=${timing.resolveProjectsMs.toFixed(0)}ms, ` +
          `tsc=${timing.tscRunsMs.toFixed(0)}ms, ` +
          `parse=${timing.parseMs.toFixed(0)}ms, ` +
          `store=${timing.storeWriteMs.toFixed(0)}ms)`,
        );
      }

      const errors = tscProvider.lastScanErrors;
      if (errors.length > 0) {
        for (const e of errors) {
          log(`[TSC-SCAN] Project error: ${e.tsconfigPath || '(workspace)'} — ${e.message}`);
        }
        window.showWarningMessage(
          `TypeScript scan completed with ${errors.length} project error(s) in ${elapsed}ms`,
        );
      } else {
        log(`[TSC-SCAN] Completed in ${elapsed}ms`);
        window.showInformationMessage(`TypeScript scan completed in ${elapsed}ms`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[TSC-SCAN] Failed: ${msg}`);
      window.showErrorMessage(`TypeScript scan failed: ${msg}`);
    }
  };
}
