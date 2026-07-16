import { ProgressLocation, window } from 'vscode';
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

    if (tscProvider.scanning) {
      window.showWarningMessage('TypeScript scan is already in progress.');
      return;
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'Scanning TypeScript projects...',
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          log('[TSC-SCAN] Cancelled by user.');
          tscProvider.stop();
        });

        const interval = setInterval(() => {
          const project = tscProvider.currentProject;
          if (project) {
            progress.report({ message: project });
          }
        }, 200);

        try {
          await tscProvider.refresh();
          const changed = folderStatusManager.rebuildAll();
          decorationEngine.fireDidChange(changed);

          clearInterval(interval);

          const totals = tscProvider.store.computeTotals();
          const timing = tscProvider.lastScanTiming;
          const elapsed = tscProvider.lastScanDurationMs.toFixed(0);
          const errors = tscProvider.lastScanErrors;

          if (token.isCancellationRequested) {
            log('[TSC-SCAN] Cancelled — no results processed.');
            return;
          }

          if (errors.length > 0) {
            for (const e of errors) {
              log(`[TSC-SCAN] Project error: ${e.tsconfigPath || '(workspace)'} — ${e.message}`);
            }
            window.showWarningMessage(
              `TypeScript scan completed with ${errors.length} project error(s)` +
              ` — ${totals.errorCount} errors, ${totals.warningCount} warnings in ${elapsed}ms`,
            );
          } else {
            log(
              `[TSC-SCAN] Completed: ${totals.errorCount} errors, ` +
              `${totals.warningCount} warnings in ${elapsed}ms`,
            );
            if (timing) {
              log(
                `[TSC-SCAN] Timing: total=${timing.totalMs.toFixed(0)}ms ` +
                `(resolve=${timing.resolveProjectsMs.toFixed(0)}ms, ` +
                `tsc=${timing.tscRunsMs.toFixed(0)}ms, ` +
                `parse=${timing.parseMs.toFixed(0)}ms, ` +
                `store=${timing.storeWriteMs.toFixed(0)}ms)`,
              );
            }
            window.showInformationMessage(
              `TypeScript scan completed: ${totals.errorCount} errors, ` +
              `${totals.warningCount} warnings in ${elapsed}ms`,
            );
          }
        } catch (err) {
          clearInterval(interval);
          const msg = err instanceof Error ? err.message : String(err);
          log(`[TSC-SCAN] Failed: ${msg}`);
          window.showErrorMessage(`TypeScript scan failed: ${msg}`);
        }
      },
    );
  };
}
