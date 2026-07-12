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
  const consoleLog = (msg: string): void => {
    const timestamp = new Date().toISOString();
    console.log(`[PE ${timestamp}] ${msg}`);
  };

  consoleLog('===== ACTIVATE START =====');

  let outputChannel: vscode.OutputChannel | undefined;
  try {
    outputChannel = vscode.window.createOutputChannel('Problem Explorer', { log: true });
    context.subscriptions.push(outputChannel);
    consoleLog('OutputChannel created OK');
  } catch (e) {
    consoleLog(`OutputChannel FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }

  const log = (msg: string): void => {
    consoleLog(msg);
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  };

  try {
    log('Creating core services...');

    const cache = new ProblemCache();
    const diagnosticsManager = new DiagnosticsManager(cache);
    const decorationEngine = new DecorationEngine(cache, undefined, log);
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
    const workspaceManager = new WorkspaceManager(
      cache,
      diagnosticsManager,
      folderStatusManager,
      decorationEngine,
    );

    const applyConfig = (): void => {
      const config = configManager.getConfig();
      diagnosticsManager.setSeverityOverrides(config.severityOverrides);
      diagnosticsManager.setIgnorePatterns(config.ignorePatterns);
      decorationEngine.setSeverityOverrides(config.severityOverrides);
      decorationEngine.setConfig(config);
    };
    applyConfig();
    log('config applied: enabled=' + configManager.getConfig().enabled);

    context.subscriptions.push(
      configManager.onDidChangeConfig(() => {
        log('config changed');
        applyConfig();
        decorationEngine.refresh();
      }),
    );

    log('registering FileDecorationProvider...');
    const regResult = vscode.window.registerFileDecorationProvider(decorationEngine);
    context.subscriptions.push(regResult);
    log('FileDecorationProvider registered OK');

    const notifyApi = (uris: vscode.Uri[]): void => {
      for (let i = 0; i < uris.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(uris[i]);
        if (folder) {
          apiManager.notifyChanged(uris[i], folder.uri);
        }
      }
    };

    const dirtyUris = new Set<string>();
    const pendingUris = new Set<string>();

    const flushUpdates = debounce(() => {
      log(`flushUpdates: pending=${pendingUris.size}`);
      for (const uriStr of pendingUris) {
        const uri = vscode.Uri.parse(uriStr);
        dirtyUris.add(uriStr);
        const ancestors = folderStatusManager.updateAncestors(uri);
        notifyApi(ancestors);
        for (let k = 0; k < ancestors.length; k++) {
          dirtyUris.add(ancestors[k].toString());
        }
      }
      pendingUris.clear();

      if (dirtyUris.size > 0) {
        const uris = Array.from(dirtyUris, (s) => vscode.Uri.parse(s));
        log(`fireDidChange: ${uris.length} URIs`);
        dirtyUris.clear();
        decorationEngine.fireDidChange(uris);
      }
      statusBarManager.update();
      trendTracker.takeSnapshot();
    }, PROCESSING_DEBOUNCE_MS);

    context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        log(`onDidChangeDiagnostics: ${e.uris.length} URIs`);
        const changed = diagnosticsManager.processChanges(e);
        log(`processChanges: ${changed.length}`);
        notifyApi(changed);
        for (let i = 0; i < changed.length; i++) {
          pendingUris.add(changed[i].toString());
        }
        if (changed.length > 0) {
          flushUpdates();
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
          pendingUris.add(uri.toString());
        }
        if (e.files.length > 0) { flushUpdates(); }
      }),
    );

    context.subscriptions.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (let i = 0; i < e.files.length; i++) {
          const { oldUri, newUri } = e.files[i];
          const folder = vscode.workspace.getWorkspaceFolder(newUri);
          if (!folder) continue;
          cache.movePrefix(oldUri, newUri, folder.uri);
          folderStatusManager.clearIndexPrefix(oldUri);
          pendingUris.add(oldUri.toString());
          pendingUris.add(newUri.toString());
        }
        if (e.files.length > 0) { flushUpdates(); }
      }),
    );

    commandManager.register(context);

    context.subscriptions.push(
      statusBarManager,
      statusBarManager.registerCommand(),
      configManager,
      workspaceManager,
      { dispose: () => { flushUpdates.cancel(); trendTracker.stop(); } },
    );

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      log(`fullScan: ${vscode.workspace.workspaceFolders!.length} folders`);
      const changed = diagnosticsManager.fullScan();
      log(`fullScan: ${changed.length} changed`);
      const changedFolders = folderStatusManager.rebuildAll();
      log(`rebuildAll: ${changedFolders.length} folders`);
      notifyApi([...changed, ...changedFolders]);
      decorationEngine.refresh();
      log('initial refresh() called');
      statusBarManager.update();
      log(`status bar: errors=${cache.computeTotals().errorCount}`);
    }

    const refreshTimeout = setTimeout(() => {
      log('5s timeout refresh');
      decorationEngine.refresh();
    }, 5000);
    context.subscriptions.push({ dispose: () => clearTimeout(refreshTimeout) });

    // TEST COMMAND - shows notification immediately
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.test', () => {
        log('TEST COMMAND RUN');
        vscode.window.showInformationMessage('Problem Explorer: TEST COMMAND WORKS!');
      }),
    );

    log('===== ACTIVATE COMPLETE =====');
    vscode.window.showInformationMessage('Problem Explorer: ACTIVATED!');

    return apiManager;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    consoleLog(`ACTIVATION CRASH: ${msg}`);
    consoleLog(`STACK: ${stack}`);
    outputChannel?.appendLine(`[${new Date().toISOString()}] CRASH: ${msg}`);
    outputChannel?.appendLine(`[${new Date().toISOString()}] STACK: ${stack}`);
    vscode.window.showErrorMessage(`Problem Explorer activation failed: ${msg}`);
    throw err;
  }
}

export function deactivate(): void {
  // All disposables in context.subscriptions are cleaned up automatically
}
