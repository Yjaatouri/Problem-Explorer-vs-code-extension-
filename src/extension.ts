import * as vscode from 'vscode';
import { ProblemCache } from './cache/cacheLayer';
import { DiagnosticsManager } from './diagnostics/diagnosticsManager';
import { DecorationEngine } from './decoration/decorationEngine';
import { FolderStatusManager } from './folder/folderStatusManager';
import { ConfigManager } from './config/configManager';
import { CommandManager } from './commands/commandManager';
import { WorkspaceManager } from './workspace/workspaceManager';
import { StatusBarManager } from './statusBar/statusBarManager';
import { debounce } from './performance/debounce';
import { PROCESSING_DEBOUNCE_MS } from './core/constants';

export function activate(context: vscode.ExtensionContext): void {
  const cache = new ProblemCache();
  const diagnosticsManager = new DiagnosticsManager(cache);
  const decorationEngine = new DecorationEngine(cache);
  const folderStatusManager = new FolderStatusManager(cache);
  const configManager = new ConfigManager();
  const commandManager = new CommandManager(
    diagnosticsManager,
    decorationEngine,
    folderStatusManager,
    configManager,
  );
  const statusBarManager = new StatusBarManager(cache);
  new WorkspaceManager(
    cache,
    diagnosticsManager,
    folderStatusManager,
    decorationEngine,
  );

  // Apply initial config
  const applyConfig = (): void => {
    const config = configManager.getConfig();
    diagnosticsManager.setSeverityOverrides(config.severityOverrides);
    decorationEngine.setSeverityOverrides(config.severityOverrides);
  };
  applyConfig();

  context.subscriptions.push(
    configManager.onDidChangeConfig(() => {
      applyConfig();
      decorationEngine.refresh();
    }),
  );

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
    statusBarManager.update();
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
    vscode.workspace.onDidDeleteFiles((e) => {
      for (let i = 0; i < e.files.length; i++) {
        const uri = e.files[i];
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
          cache.delete(uri, folder.uri);
          dirtyUris.add(uri.toString());
          const ancestors = folderStatusManager.updateAncestors(uri);
          for (let j = 0; j < ancestors.length; j++) {
            dirtyUris.add(ancestors[j].toString());
          }
        }
      }
      if (e.files.length > 0) {
        debouncedFire();
      }
    }),
  );

  commandManager.register(context);

  context.subscriptions.push(
    statusBarManager,
    statusBarManager.registerCommand(),
    { dispose: () => debouncedFire.cancel() },
  );

  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    const changed = diagnosticsManager.fullScan();
    const changedFolders = folderStatusManager.rebuildAll();
    const allChanged = [...changed, ...changedFolders];
    if (allChanged.length > 0) {
      decorationEngine.fireDidChange(allChanged);
    }
    statusBarManager.update();
  }
}

export function deactivate(): void {
  // All disposables in context.subscriptions are cleaned up automatically
}
