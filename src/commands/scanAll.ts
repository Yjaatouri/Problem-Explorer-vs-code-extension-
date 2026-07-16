import { TscDiagnosticProvider } from '../providers/TscDiagnosticProvider';
import { EslintDiagnosticProvider } from '../providers/EslintDiagnosticProvider';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { StatusBarManager } from '../statusBar/statusBarManager';

export function createScanAllHandler(
  tscProvider: TscDiagnosticProvider | undefined,
  eslintProvider: EslintDiagnosticProvider | undefined,
  folderStatusManager: FolderStatusManager,
  decorationEngine: DecorationEngine,
  statusBarManager: StatusBarManager,
  log: (msg: string) => void,
): () => Promise<void> {
  return async () => {
    log('[SCAN-ALL] Starting full scan...');

    const promises: Promise<void>[] = [];

    if (tscProvider && tscProvider.enabled) {
      log('[SCAN-ALL] Triggering tsc scan...');
      promises.push(tscProvider.refresh());
    }

    if (eslintProvider && eslintProvider.enabled) {
      log('[SCAN-ALL] Triggering eslint scan...');
      promises.push(eslintProvider.refresh());
    }

    await Promise.all(promises);

    const changed = folderStatusManager.rebuildAll();
    decorationEngine.fireDidChange(changed);
    statusBarManager.update();

    log('[SCAN-ALL] Full scan complete');
  };
}
