import * as vscode from 'vscode';
import { ProblemCache } from './cache/cacheLayer';
import { DiagnosticsManager } from './diagnostics/diagnosticsManager';
import { DecorationEngine, dumpForensicReport } from './decoration/decorationEngine';
import { FolderStatusManager } from './folder/folderStatusManager';
import { ConfigManager } from './config/configManager';
import { CommandManager } from './commands/commandManager';
import { WorkspaceManager } from './workspace/workspaceManager';
import { StatusBarManager } from './statusBar/statusBarManager';
import { ApiManager, ProblemExplorerAPI } from './api/problemExplorerApi';
import { initForensicLogger, forensicLog } from './forensicLogger';
import { TrendTracker, MementoStorageProvider } from './trend/trendTracker';
import { VSDiagnosticsProvider } from './providers/VSDiagnosticsProvider';

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

  // Initialize forensic logger to route through this log function
  initForensicLogger(log);
  forensicLog('===== FORENSIC LOGGER INITIALIZED =====');

  try {
    log('Creating core services...');

    const cache = new ProblemCache();
    const diagnosticsManager = new DiagnosticsManager(cache);
    const decorationEngine = new DecorationEngine(cache, log);
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

    const vsDiagnosticsProvider = new VSDiagnosticsProvider(
      diagnosticsManager,
      folderStatusManager,
      apiManager,
      decorationEngine,
      statusBarManager,
      trendTracker,
      log,
    );
    vsDiagnosticsProvider.start();

    const applyConfig = (): void => {
      const config = configManager.getConfig();
      diagnosticsManager.setSeverityOverrides(config.severityOverrides);
      diagnosticsManager.setIgnorePatterns(config.ignorePatterns);
    };
    applyConfig();
    log('config applied: enabled=' + configManager.getConfig().enabled);

    context.subscriptions.push(
      configManager.onDidChangeConfig(() => {
        log('config changed');
        applyConfig();
      }),
    );

    log('[FORENSIC:Step7] registerFileDecorationProvider START');
    const regResult = vscode.window.registerFileDecorationProvider(decorationEngine);
    context.subscriptions.push(regResult);
    log('[FORENSIC:Step7] registerFileDecorationProvider OK — Disposable registered');
    log('[FORENSIC:Step7] provider instance alive: ' + (decorationEngine ? 'YES' : 'NO'));
    log('[FORENSIC:Step7] provider is FileDecorationProvider interface: ' + (typeof decorationEngine.provideFileDecoration === 'function' ? 'YES' : 'NO'));
    log('[FORENSIC:Step7] provider onDidChangeFileDecorations is Event: ' + (typeof decorationEngine.onDidChangeFileDecorations === 'object' ? 'YES' : 'NO'));

    context.subscriptions.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        for (let i = 0; i < e.files.length; i++) {
          const uri = e.files[i];
          const folder = vscode.workspace.getWorkspaceFolder(uri);
          if (!folder) continue;
          cache.delete(uri, folder.uri);
          cache.deletePrefix(uri, folder.uri);
          folderStatusManager.clearIndexPrefix(uri);
          vsDiagnosticsProvider.markPending(uri);
        }
        if (e.files.length > 0) { vsDiagnosticsProvider.flush(); }
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
          vsDiagnosticsProvider.markPending(oldUri);
          vsDiagnosticsProvider.markPending(newUri);
        }
        if (e.files.length > 0) { vsDiagnosticsProvider.flush(); }
      }),
    );

    commandManager.register(context);

    context.subscriptions.push(
      statusBarManager,
      statusBarManager.registerCommand(),
      configManager,
      workspaceManager,
      { dispose: () => { trendTracker.stop(); } },
    );

    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      log(`[FORENSIC:Step1-init] fullScan START: ${vscode.workspace.workspaceFolders!.length} folders`);
      const allDiags = vscode.languages.getDiagnostics();
      log(`[FORENSIC:Step1-init] languages.getDiagnostics() returned ${allDiags.length} entries`);
      for (let i = 0; i < Math.min(allDiags.length, 10); i++) {
        const [u, d] = allDiags[i];
        log(`[FORENSIC:Step1-init]   URI[${i}]=${u.toString(true)} diagCount=${d.length}`);
      }
      if (allDiags.length > 10) {
        log(`[FORENSIC:Step1-init]   ... and ${allDiags.length - 10} more`);
      }
      const changed = diagnosticsManager.fullScan();
      log(`[FORENSIC:Step1-init] fullScan returned ${changed.length} changed URIs`);
      const changedFolders = folderStatusManager.rebuildAll();
      log(`[FORENSIC:Step1-init] rebuildAll returned ${changedFolders.length} folders`);
      const initialUris = [...changed, ...changedFolders];
      for (let i = 0; i < initialUris.length; i++) {
        const folder = vscode.workspace.getWorkspaceFolder(initialUris[i]);
        if (folder) {
          apiManager.notifyChanged(initialUris[i], folder.uri);
        }
      }
      decorationEngine.refresh();
      log('[FORENSIC:Step4] initial refresh() called → fireDidChange(undefined)');
      statusBarManager.update();
      log(`[FORENSIC:Step1-init] status bar: errors=${cache.computeTotals().errorCount} warnings=${cache.computeTotals().warningCount} info=${cache.computeTotals().infoCount}`);
    }

    // Poll until TypeScript produces non-zero diagnostics, then do a forced fullScan + refresh
    let pollAttempts = 0;
    const pollInterval = setInterval(() => {
      pollAttempts++;
      const totalDiags = vscode.languages.getDiagnostics();
      let totalCount = 0;
      for (let i = 0; i < totalDiags.length; i++) {
        totalCount += totalDiags[i][1].length;
      }
      log(`[INIT-POLL] attempt=${pollAttempts} totalDiags=${totalCount}`);
      if (totalCount > 0 || pollAttempts >= 10) {
        clearInterval(pollInterval);
        const changed = diagnosticsManager.fullScan();
        log(`[INIT-POLL] late fullScan: ${changed.length} changed`);
        const changedFolders = folderStatusManager.rebuildAll();
        log(`[INIT-POLL] late rebuildAll: ${changedFolders.length} folders`);
        const pollUris = [...changed, ...changedFolders];
        for (let i = 0; i < pollUris.length; i++) {
          const folder = vscode.workspace.getWorkspaceFolder(pollUris[i]);
          if (folder) {
            apiManager.notifyChanged(pollUris[i], folder.uri);
          }
        }
        decorationEngine.refresh();
        statusBarManager.update();
        log(`[INIT-POLL] status bar: errors=${cache.computeTotals().errorCount} warnings=${cache.computeTotals().warningCount} info=${cache.computeTotals().infoCount}`);
      }
    }, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

    // TEST COMMAND - shows notification immediately
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.test', () => {
        log('TEST COMMAND RUN');
        vscode.window.showInformationMessage('Problem Explorer: TEST COMMAND WORKS!');
      }),
    );

// FORENSIC REPORT COMMAND
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.forensicReport', () => {
        const report = dumpForensicReport();
        log(report);
        log(`[FORENSIC:REPORT] diagEventCount=${vsDiagnosticsProvider.eventCount}`);
        vscode.window.showInformationMessage('Forensic report dumped to console (DevTools)');
      }),
    );

    log('===== ACTIVATE COMPLETE =====');
    vscode.window.showInformationMessage('Problem Explorer: ACTIVATED!');

    // Auto-dump forensic report after 15s
    const forensicTimeout = setTimeout(() => {
      log('[FORENSIC] Auto-dumping forensic report after 15s...');
      log(dumpForensicReport());
      log(`[FORENSIC] diagEventCount=${vsDiagnosticsProvider.eventCount}`);
    }, 15000);
    context.subscriptions.push({ dispose: () => clearTimeout(forensicTimeout) });

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
