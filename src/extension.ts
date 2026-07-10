import * as vscode from 'vscode';
import { ProblemCache } from './cache/cacheLayer';
import { DiagnosticsManager } from './diagnostics/diagnosticsManager';
import { DecorationEngine } from './decoration/decorationEngine';
import { FolderStatusManager } from './folder/folderStatusManager';
import { debounce } from './performance/debounce';
import { PROCESSING_DEBOUNCE_MS } from './core/constants';

export function activate(context: vscode.ExtensionContext): void {
  const cache = new ProblemCache();
  const diagnosticsManager = new DiagnosticsManager(cache);
  const decorationEngine = new DecorationEngine(cache);
  const folderStatusManager = new FolderStatusManager(cache);

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationEngine),
  );

  const dirtyUris = new Set<string>();
  const debouncedFire = debounce(() => {
    if (dirtyUris.size > 0) {
      const uris = Array.from(dirtyUris, (s) => vscode.Uri.parse(s));
      dirtyUris.clear();
      decorationEngine.fireDidChange(uris);
    }
  }, PROCESSING_DEBOUNCE_MS);

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      const changed = diagnosticsManager.processChanges(e);
      for (let i = 0; i < changed.length; i++) {
        dirtyUris.add(changed[i].toString());
        const ancestors = folderStatusManager.updateAncestors(changed[i]);
        for (let j = 0; j < ancestors.length; j++) {
          dirtyUris.add(ancestors[j].toString());
        }
      }
      if (changed.length > 0) {
        debouncedFire();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('problemExplorer.refresh', () => {
      diagnosticsManager.fullScan();
      decorationEngine.refresh();
    }),
  );

  context.subscriptions.push({ dispose: () => debouncedFire.cancel() });

  const changed = diagnosticsManager.fullScan();
  const changedFolders = folderStatusManager.rebuildAll();
  const allChanged = [...changed, ...changedFolders];
  if (allChanged.length > 0) {
    decorationEngine.fireDidChange(allChanged);
  }
}

export function deactivate(): void {
  // All disposables in context.subscriptions are cleaned up automatically
}
