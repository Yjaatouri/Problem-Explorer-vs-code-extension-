import * as vscode from 'vscode';
import { ProblemCache } from './cache/cacheLayer';
import { DiagnosticsManager } from './diagnostics/diagnosticsManager';
import { DecorationEngine } from './decoration/decorationEngine';
import { FolderStatusManager } from './folder/folderStatusManager';
import { ConfigManager } from './config/configManager';
import { CommandManager } from './commands/commandManager';
import { WorkspaceManager } from './workspace/workspaceManager';
import { StatusBarManager } from './statusBar/statusBarManager';
import { ApiManager, ProblemExplorerAPI } from './api/problemExplorerApi';
import { TrendTracker, MementoStorageProvider } from './trend/trendTracker';
import { debounce } from './performance/debounce';
import { PROCESSING_DEBOUNCE_MS } from './core/constants';

export function activate(context: vscode.ExtensionContext): ProblemExplorerAPI {
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
  const apiManager = new ApiManager(cache);
  const trendTracker = new TrendTracker(
    cache,
    new MementoStorageProvider(context.globalState),
  );
  trendTracker.start();
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
    diagnosticsManager.setIgnorePatterns(config.ignorePatterns);
    decorationEngine.setSeverityOverrides(config.severityOverrides);
    decorationEngine.setConfig(config);
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

  // Notify the public API that a URI's status has changed
  const notifyApi = (uris: vscode.Uri[]): void => {
    for (let i = 0; i < uris.length; i++) {
      const folder = vscode.workspace.getWorkspaceFolder(uris[i]);
      if (folder) {
        apiManager.notifyChanged(uris[i], folder.uri);
      }
    }
  };

  const dirtyUris = new Set<string>();
  const debouncedFire = debounce(() => {
    if (dirtyUris.size > 0) {
      const uris = Array.from(dirtyUris, (s) => vscode.Uri.parse(s));
      dirtyUris.clear();
      decorationEngine.fireDidChange(uris);
    }
    statusBarManager.update();
    trendTracker.takeSnapshot();
  }, PROCESSING_DEBOUNCE_MS);

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      const changed = diagnosticsManager.processChanges(e);
      notifyApi(changed);
      for (let i = 0; i < changed.length; i++) {
        dirtyUris.add(changed[i].toString());
        const ancestors = folderStatusManager.updateAncestors(changed[i]);
        notifyApi(ancestors);
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
        if (!folder) continue;

        cache.delete(uri, folder.uri);
        cache.deletePrefix(uri, folder.uri);
        folderStatusManager.clearIndexPrefix(uri);

        dirtyUris.add(uri.toString());
        const ancestors = folderStatusManager.updateAncestors(uri);
        notifyApi(ancestors);
        for (let j = 0; j < ancestors.length; j++) {
          dirtyUris.add(ancestors[j].toString());
        }
      }
      if (e.files.length > 0) {
        debouncedFire();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((e) => {
      for (let i = 0; i < e.files.length; i++) {
        const { oldUri, newUri } = e.files[i];
        const folder = vscode.workspace.getWorkspaceFolder(newUri);
        if (!folder) continue;

        // Move all cache entries and clear stale index entries
        cache.movePrefix(oldUri, newUri, folder.uri);
        folderStatusManager.clearIndexPrefix(oldUri);

        // Remove old path from ancestor chain
        dirtyUris.add(oldUri.toString());
        const oldAncestors = folderStatusManager.updateAncestors(oldUri);
        notifyApi(oldAncestors);
        for (let j = 0; j < oldAncestors.length; j++) {
          dirtyUris.add(oldAncestors[j].toString());
        }

        // Add new path to ancestor chain
        dirtyUris.add(newUri.toString());
        const newAncestors = folderStatusManager.updateAncestors(newUri);
        notifyApi(newAncestors);
        for (let j = 0; j < newAncestors.length; j++) {
          dirtyUris.add(newAncestors[j].toString());
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
    { dispose: () => { debouncedFire.cancel(); trendTracker.stop(); } },
  );

  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    const changed = diagnosticsManager.fullScan();
    const changedFolders = folderStatusManager.rebuildAll();
    notifyApi([...changed, ...changedFolders]);
    decorationEngine.refresh();
    statusBarManager.update();
  }

  // Re-query decorations after language servers have had time to provide diagnostics
  setTimeout(() => { decorationEngine.refresh(); }, 5000);

  return apiManager;
}

export function deactivate(): void {
  // All disposables in context.subscriptions are cleaned up automatically
}
