import { ProgressLocation, window } from 'vscode';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { StatusBarManager } from '../statusBar/statusBarManager';

export function createScanWorkspaceHandler(
  manager: DiagnosticProviderManager,
  folderStatusManager: FolderStatusManager,
  decorationEngine: DecorationEngine,
  statusBarManager: StatusBarManager,
  log: (msg: string) => void,
): () => Promise<void> {
  return async () => {
    log('[SCAN-WORKSPACE] Starting workspace scan...');
    const startTime = performance.now();

    // Refresh every registered provider
    const names = manager.all().map((info) => info.name);
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
          manager.stopAll();
        });

        try {
          await manager.refreshByNames(names);
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
