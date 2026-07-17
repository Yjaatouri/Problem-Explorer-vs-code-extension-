import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { normalizeUriKey } from './core/uriKey';
import { DecorationEngine, dumpForensicReport } from './decoration/decorationEngine';
import { FolderStatusManager } from './folder/folderStatusManager';
import { ConfigManager } from './config/configManager';
import { CommandManager } from './commands/commandManager';
import { WorkspaceManager } from './workspace/workspaceManager';
import { StatusBarManager } from './statusBar/statusBarManager';
import { ApiManager, ProblemExplorerAPI } from './api/problemExplorerApi';
import { initForensicLogger, forensicLog, dumpChainReport, resetChainCounters } from './forensicLogger';
import { TrendTracker, MementoStorageProvider } from './trend/trendTracker';
import { ProblemStore } from './store/ProblemStore';
import { DiagnosticProviderManager } from './providers/DiagnosticProviderManager';
import { VSCodeDiagnosticProvider } from './providers/VSCodeDiagnosticProvider';
import { TscDiagnosticProvider } from './providers/TscDiagnosticProvider';
import { EslintDiagnosticProvider } from './providers/EslintDiagnosticProvider';
import { VSDiagnosticsProvider } from './providers/VSDiagnosticsProvider';
import { AutoScanController } from './scanner/AutoScanner';
import { StartupScanController } from './scanner/StartupScanController';
import { ScanWorkspaceButton } from './scanButton/ScanWorkspaceButton';
import { setConfigManager } from './core/debug';

console.log('[LOG:DIST_LOADED]');

export async function activate(context: vscode.ExtensionContext): Promise<ProblemExplorerAPI> {
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

    const problemStore = new ProblemStore();
    const diagProviderManager = new DiagnosticProviderManager();
    const diagProvider = new VSCodeDiagnosticProvider(
      problemStore,
      {
        getAllDiagnostics: () => vscode.languages.getDiagnostics(),
        getUriDiagnostics: (uri) => vscode.languages.getDiagnostics(uri),
        getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
        isActiveEditorUri: (uri) => {
          const editor = vscode.window.activeTextEditor;
          return editor ? editor.document.uri.toString() === uri.toString() : false;
        },
      },
      diagProviderManager,
      log,
    );
    const decorationEngine = new DecorationEngine(problemStore, {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
}, log);
    const folderStatusManager = new FolderStatusManager(problemStore);
    const configManager = new ConfigManager();
    setConfigManager(configManager);
    setConfigManager(configManager);
    const tscProvider = new TscDiagnosticProvider(
      problemStore,
      undefined, undefined, undefined,
      configManager.getConfig().typescript.timeout,
    );
    const eslintProvider = new EslintDiagnosticProvider(problemStore, diagProviderManager);
    const statusBarManager = new StatusBarManager(problemStore);

    // Provider priorities must match ProblemStore.configureProvider() values below.
    // DPM uses priority for: (1) ownership routing (non-realtime providers compete by priority),
    // (2) init/start/stop ordering. ProblemStore uses priority for write-conflict resolution.
    diagProviderManager.register(diagProvider.name, diagProvider, {
      priority: 5,
      capabilities: ['diagnostics', 'realtime'],
    });
    diagProviderManager.register('tsc', tscProvider, {
      priority: 10,
      capabilities: ['diagnostics', 'tsc-scan'],
    });
    diagProviderManager.register('eslint', eslintProvider, {
      priority: 9,
      capabilities: ['diagnostics', 'eslint-scan'],
    });

    const commandManager = new CommandManager(
      diagProviderManager,
      diagProvider,
      decorationEngine,
      folderStatusManager,
      configManager,
      statusBarManager,
      log,
    );
    const apiManager = new ApiManager(problemStore);
    const trendTracker = new TrendTracker(
      problemStore,
      new MementoStorageProvider(context.globalState),
    );
    trendTracker.start();
    const workspaceManager = new WorkspaceManager(
      problemStore,
      diagProvider,
      folderStatusManager,
      decorationEngine,
    );

    // Provider ownership priorities in ProblemStore (must match DPM register() priorities above).
    // Compiler (tsc) is authoritative — it performs full project compilation.
    // Linter (eslint) is next — cross-file linting rules.
    // Language server (vscodeDiagnostics) is least authoritative — editor-scoped, incremental.
    problemStore.configureProvider('tsc', 10);
    problemStore.configureProvider('eslint', 9);
    problemStore.configureProvider('vscodeDiagnostics', 5);

    const vsDiagnosticsProvider = new VSDiagnosticsProvider(
      diagProviderManager,
      folderStatusManager,
      apiManager,
      decorationEngine,
      statusBarManager,
      trendTracker,
      log,
    );

    console.log('[LOG:PRE_INIT] about to call initializeAll()');
    await diagProviderManager.initializeAll();
    console.log('[LOG:POST_INIT] initializeAll() completed');
    log('[VERIFY] All diagnostic providers initialized');
    log(`[VERIFY] Providers: ${diagProviderManager.all().map(p => p.name + '=' + p.state).join(', ')}`);

    diagProviderManager.startAll();
    log('[VERIFY] All diagnostic providers started');

    diagProvider.startInitPoll();

    vsDiagnosticsProvider.start();
    log('[VERIFY] VSDiagnosticsProvider started');
    log(`[VERIFY] Store entries after init: ${problemStore.size()}`);

    const applyConfig = (): void => {
      const config = configManager.getConfig();
      diagProvider.setSeverityOverrides(config.severityOverrides);
      diagProvider.setIgnorePatterns(config.ignorePatterns);
      tscProvider.updateConfig(config.typescript);
      eslintProvider.updateConfig(config.eslint);
    };
    applyConfig();
    const tscCfg = configManager.getConfig().typescript;
    const eslintCfg = configManager.getConfig().eslint;
    log('config applied: enabled=' + configManager.getConfig().enabled + ', tsc.enabled=' + tscCfg.enabled + ', eslint.enabled=' + eslintCfg.enabled);

    // Start all providers with startupScan capability (non-blocking)
    const startupController = new StartupScanController(
      diagProviderManager,
      log,
      (name) => name === 'tsc' && !tscCfg.scanOnStartup,
    );
    startupController.run();
    context.subscriptions.push(startupController);

    // AutoScan is enabled by default. Set "problemExplorer.autoScan.enabled": false to disable.
    const autoScannerCfg = configManager.getConfig();
    let autoScanController: AutoScanController | undefined;
    if (autoScannerCfg.autoScanEnabled) {
      autoScanController = new AutoScanController(diagProviderManager, statusBarManager, log, autoScannerCfg.autoScanDelay, autoScannerCfg.autoScanEnabled);
      autoScanController.start();
      context.subscriptions.push(autoScanController);
      log('[VERIFY] AutoScanController created (feature flag enabled)');
    } else {
      log('[VERIFY] AutoScanController not created (feature flag disabled)');
    }

    // Scan Workspace button (status bar + explorer toolbar)
    new ScanWorkspaceButton(context, diagProviderManager, log);
    log('[VERIFY] ScanWorkspaceButton created');

    let prevTscEnabled = tscCfg.enabled;
    let prevEslintEnabled = eslintCfg.enabled;
    context.subscriptions.push(
      configManager.onDidChangeConfig(() => {
        log('config changed');
        const prevTsc = prevTscEnabled;
        const prevEslint = prevEslintEnabled;
        applyConfig();
        const currCfg = configManager.getConfig();
        const currTsc = currCfg.typescript;
        const currEslint = currCfg.eslint;
        prevTscEnabled = currTsc.enabled;
        prevEslintEnabled = currEslint.enabled;
        autoScanController?.updateConfig(currCfg.autoScanDelay, currCfg.autoScanEnabled);
        if (currTsc.enabled && !prevTsc) {
          log('[TSC] Scan enabled via config change — triggering scan');
          tscProvider.refresh();
        }
        if (currEslint.enabled && !prevEslint) {
          log('[ESLINT] Scan enabled via config change — triggering scan');
          eslintProvider.refresh();
        }
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
          problemStore.deleteByPrefix(normalizeUriKey(uri));
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
          problemStore.movePrefix(normalizeUriKey(oldUri), normalizeUriKey(newUri));
          folderStatusManager.clearIndexPrefix(oldUri);
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
      tscProvider,
      eslintProvider,
      diagProviderManager,
      vsDiagnosticsProvider,
      decorationEngine,
      apiManager,
      { dispose: () => { trendTracker.stop(); } },
    );

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
        const chain = dumpChainReport();
        log(chain);
        vscode.window.showInformationMessage('Forensic report dumped to console (DevTools)');
      }),
    );

    // RESET CHAIN COUNTERS COMMAND
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.resetChainCounters', () => {
        resetChainCounters();
        log('[CHAIN:REPORT] Chain counters reset');
        vscode.window.showInformationMessage('Chain counters reset');
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
