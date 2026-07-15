import * as vscode from 'vscode';
import { workspace } from 'vscode';
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
import { ProblemStore } from './store/ProblemStore';
import { ProviderManager } from './services/ProviderManager';
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
    const problemStore = new ProblemStore();
    const diagnosticsManager = new DiagnosticsManager(cache, problemStore);
    const decorationEngine = new DecorationEngine(problemStore, {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
}, log);
    const folderStatusManager = new FolderStatusManager(problemStore);
    const configManager = new ConfigManager();
    const commandManager = new CommandManager(
      diagnosticsManager,
      decorationEngine,
      folderStatusManager,
      configManager,
    );
    const statusBarManager = new StatusBarManager(problemStore);
    const apiManager = new ApiManager(problemStore);
    const trendTracker = new TrendTracker(
      problemStore,
      new MementoStorageProvider(context.globalState),
    );
    trendTracker.start();
    const workspaceManager = new WorkspaceManager(
      problemStore,
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

    const providerManager = new ProviderManager();
    providerManager.register('vsDiagnostics', vsDiagnosticsProvider);
    providerManager.startAll();

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
          problemStore.delete(uri);
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
          problemStore.delete(oldUri);
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
      problemStore,
      providerManager,
      { dispose: () => { trendTracker.stop(); } },
    );

    // TEST COMMAND - shows notification immediately
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.test', () => {
        log('TEST COMMAND RUN');
        vscode.window.showInformationMessage('Problem Explorer: TEST COMMAND WORKS!');
      }),
    );

    // EXPERIMENT COMMAND - runs diagnostics experiments (dev only)
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.runExperiment', async () => {
        log('EXPERIMENT COMMAND RUN');
        const outputChannel = vscode.window.createOutputChannel('Problem Explorer Experiments');
        outputChannel.show();
        function elog(msg: string) { outputChannel.appendLine(`[experiment] ${msg}`); }

        // Phase 0: Check ALL diagnostics in workspace
        elog('=== Phase 0: All diagnostics in workspace ===');
        const allDiag = vscode.languages.getDiagnostics();
        elog(`Total diagnostic entries in workspace: ${allDiag.length}`);
        for (const [uri, diags] of allDiag) {
          elog(`  ${uri.toString().substring(0, 80)}: ${diags.length} diagnostics`);
          for (const d of diags.slice(0, 3)) {
            elog(`    [${d.source}] ${d.message.substring(0, 100)}`);
          }
        }

        // Phase 1: Create a temp file with intentional TypeScript errors
        elog('');
        elog('=== Phase 1: create temp file with errors ===');
        const tempFile = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '__temp_error_test__.ts');
        await vscode.workspace.fs.writeFile(tempFile, Buffer.from(
          'const x: number = "not a number";\n' +
          'function foo(a: number): string { return a; }\n' +
          'console.log(x, foo);\n'
        ));
        elog(`Temp file created: ${tempFile.toString()}`);

        // Check before open
        const beforeTemp = vscode.languages.getDiagnostics(tempFile);
        elog(`Temp file diagnostics BEFORE open: ${beforeTemp.length}`);

        // Open in editor tab
        const tempDoc = await vscode.workspace.openTextDocument(tempFile);
        await vscode.window.showTextDocument(tempDoc);
        elog('Temp file opened in editor, waiting 4s...');
        await new Promise((r) => setTimeout(r, 4000));

        const afterTemp = vscode.languages.getDiagnostics(tempFile);
        elog(`Temp file diagnostics AFTER open: ${afterTemp.length}`);
        for (const d of afterTemp) {
          elog(`  [${d.source}] ${d.message} (severity=${d.severity})`);
        }

        // Phase 2: Check known file broken-calculator.ts after everything
        elog('');
        elog('=== Phase 2: broken-calculator.ts ===');
        const broken = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'broken-calculator.ts');
        const brokenDiag = vscode.languages.getDiagnostics(broken);
        elog(`broken-calculator.ts diagnostics: ${brokenDiag.length}`);
        for (const d of brokenDiag) {
          elog(`  [${d.source}] ${d.message}`);
        }

        // Phase 3: Re-check ALL diagnostics in workspace
        elog('');
        elog('=== Phase 3: All diagnostics in workspace (after test) ===');
        const allDiag2 = vscode.languages.getDiagnostics();
        elog(`Total diagnostic entries: ${allDiag2.length}`);
        for (const [uri, diags] of allDiag2) {
          elog(`  ${uri.toString().substring(0, 80)}: ${diags.length}`);
        }

        // Clean up temp file
        try { await vscode.workspace.fs.delete(tempFile); } catch {}
        elog('');
        elog('=== EXPERIMENT COMPLETE ===');
        vscode.window.showInformationMessage('Experiment complete — check output channel');
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
