import { ProgressLocation, window } from 'vscode';
import { ScanScheduler } from '../scanner/ScanScheduler';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { StatusBarManager } from '../statusBar/statusBarManager';

export function createScanWorkspaceHandler(
  scheduler: ScanScheduler,
  folderStatusManager: FolderStatusManager,
  decorationEngine: DecorationEngine,
  statusBarManager: StatusBarManager,
  log: (msg: string) => void,
): () => Promise<void> {
  return async () => {
    log('[SCAN-WORKSPACE] Starting workspace scan...');
    const startTime = performance.now();

    const names = scheduler.registry.all().map((rp) => rp.descriptor.id);
    if (names.length === 0) {
      log('[SCAN-WORKSPACE] No providers registered — nothing to scan');
      return;
    }

    log(`[SCAN-WORKSPACE] Providers: ${names.join(', ')}`);

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: 'Problem Explorer: Scanning workspace...',
        cancellable: true,
      },
      async (_progress, token) => {
        token.onCancellationRequested(() => {
          log('[SCAN-WORKSPACE] Cancelled by user.');
          scheduler.manager.stopAll();
        });

        try {
          await scheduler.submit({
            providerNames: names,
            reason: 'manual scan workspace',
            source: 'manual',
          });
        } catch (e) {
          log(`[SCAN-WORKSPACE] Scan error: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (token.isCancellationRequested) {
          log('[SCAN-WORKSPACE] Cancelled — no results processed.');
          return;
        }

        const changed = folderStatusManager.rebuildAll();
        decorationEngine.fireDidChange(changed);
        statusBarManager.update();

        const elapsed = (performance.now() - startTime).toFixed(0);
        log(`[SCAN-WORKSPACE] Completed in ${elapsed}ms`);
        window.showInformationMessage(
          `Problem Explorer: Workspace scan completed in ${elapsed}ms`,
        );
      },
    );
  };
}
