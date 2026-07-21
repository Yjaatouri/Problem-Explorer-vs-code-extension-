import * as vscode from 'vscode';
import { workspace } from 'vscode';
import * as fs from 'fs';
import { normalizeUriKey } from './core/uriKey';
import { DecorationEngine } from './decoration/decorationEngine';
import { FolderStatusManager } from './folder/folderStatusManager';
import { ConfigManager } from './config/configManager';
import { CommandManager } from './commands/commandManager';
import { WorkspaceManager } from './workspace/workspaceManager';
import { StatusBarManager } from './statusBar/statusBarManager';
import { ApiManager, ProblemExplorerAPI } from './api/problemExplorerApi';

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
import { TelemetryConfigManager } from './telemetry/TelemetryConfig';
import { createTelemetryReporter } from './telemetry/TelemetryReporter';
import { getTelemetryBus } from './telemetry/TelemetryBus';
import { createStoreMonitor } from './telemetry/monitors/StoreMonitor';
import { createProviderMonitor } from './telemetry/monitors/ProviderMonitor';
import { createAutoScannerMonitor } from './telemetry/monitors/AutoScannerMonitor';
import { createDiagnosticsMonitor } from './telemetry/monitors/DiagnosticsMonitor';
import { createDecorationMonitor } from './telemetry/monitors/DecorationMonitor';
import { createFolderMonitor } from './telemetry/monitors/FolderMonitor';
import { createEventPipelineMonitor, PipelineId } from './telemetry/monitors/EventPipelineMonitor';
import { createTimerMonitor } from './telemetry/monitors/TimerMonitor';
import { createPerformanceMonitor } from './telemetry/monitors/PerformanceMonitor';
import { createRuntimeAssertions } from './telemetry/monitors/RuntimeAssertions';
import { createTimelineGenerator, TimelineGenerator } from './telemetry/monitors/TimelineGenerator';
import { createSnapshotSystem } from './telemetry/monitors/SnapshotSystem';
import { createFileLogger, FileLogger } from './telemetry/monitors/FileLogger';
import { createTelemetryFileLogger } from './telemetry/monitors/TelemetryFileLogger';
import { TelemetryLogEditorProvider } from './telemetry/monitors/TelemetryLogEditorProvider';
import { Dashboard } from './telemetry/dashboard/Dashboard';

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
});
    const folderStatusManager = new FolderStatusManager(problemStore);
    const configManager = new ConfigManager();
    setConfigManager(configManager);

    // Initialize telemetry system
    const telemetryConfig = new TelemetryConfigManager();
    const telemetryReporter = createTelemetryReporter(telemetryConfig);
    const monitoringLevel = telemetryConfig.getConfig().monitoring;

    // Monitors, dashboard, assertions — only created in 'full' mode
    let storeMonitor: import('./telemetry/monitors/StoreMonitor').StoreMonitor | undefined;
    let providerMonitor: import('./telemetry/monitors/ProviderMonitor').ProviderMonitor | undefined;
    let autoScannerMonitor: import('./telemetry/monitors/AutoScannerMonitor').AutoScannerMonitor | undefined;
    let diagnosticsMonitor: import('./telemetry/monitors/DiagnosticsMonitor').DiagnosticsMonitor | undefined;
    let decorationMonitor: import('./telemetry/monitors/DecorationMonitor').DecorationMonitor | undefined;
    let folderMonitor: import('./telemetry/monitors/FolderMonitor').FolderMonitor | undefined;
    let pipelineMonitor: import('./telemetry/monitors/EventPipelineMonitor').EventPipelineMonitor | undefined;
    let timerMonitor: import('./telemetry/monitors/TimerMonitor').TimerMonitor | undefined;
    let perfMonitor: import('./telemetry/monitors/PerformanceMonitor').PerformanceMonitor | undefined;
    let runtimeAssertions: ReturnType<typeof createRuntimeAssertions> | undefined;
    let timelineGenerator: ReturnType<typeof createTimelineGenerator> | undefined;
    let snapshotSystem: ReturnType<typeof createSnapshotSystem> | undefined;
    let devDashboard: Dashboard | undefined;
    let telemetryFileLogger: import('./telemetry/monitors/TelemetryFileLogger').TelemetryFileLogger | undefined;
    let fileLogger: FileLogger | undefined;

    if (monitoringLevel === 'full') {
      const mStoreMonitor = createStoreMonitor(problemStore, telemetryReporter);
      const mProviderMonitor = createProviderMonitor(diagProviderManager, telemetryReporter);
      const mAutoScannerMonitor = createAutoScannerMonitor(diagProviderManager, telemetryReporter);
      const mDiagnosticsMonitor = createDiagnosticsMonitor(diagProviderManager, telemetryReporter);
      const mDecorationMonitor = createDecorationMonitor(decorationEngine, telemetryReporter, problemStore);
      const mFolderMonitor = createFolderMonitor(folderStatusManager, problemStore, telemetryReporter);
      const mPipelineMonitor = createEventPipelineMonitor(telemetryReporter);
      const mTimerMonitor = createTimerMonitor(telemetryReporter);
      const mPerfMonitor = createPerformanceMonitor(telemetryReporter);
      const mRuntimeAssertions = createRuntimeAssertions(telemetryReporter);
      const mTimelineGenerator = createTimelineGenerator(telemetryReporter);
      const mSnapshotSystem = createSnapshotSystem(
        telemetryReporter, problemStore, diagProviderManager, telemetryConfig,
        mStoreMonitor, mProviderMonitor, mAutoScannerMonitor, mDiagnosticsMonitor,
        mFolderMonitor, mDecorationMonitor, mPipelineMonitor, mRuntimeAssertions,
        mTimelineGenerator,
      );
      try {
        const wf = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        mSnapshotSystem.setEnvironmentInfo(vscode.version, context.extension.packageJSON.version ?? 'unknown', wf);
      } catch { /* non-critical */ }

      // Legacy file logger for offline forensic analysis
      try {
        const logDir = context.logUri.fsPath;
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        telemetryFileLogger = createTelemetryFileLogger(telemetryReporter, logDir);
        const wf = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)[0];
        fileLogger = createFileLogger(telemetryReporter, logDir, undefined, undefined, context.extension.packageJSON.version ?? 'unknown', vscode.version, wf);
        fileLogger.startSession().catch(() => {});
        fileLogger.cleanupOldSessions(20);
      } catch (e) {
        log(`[TELEMETRY] Failed to create file logger: ${e}`);
      }

      const mDevDashboard = new Dashboard(
        context.extensionUri,
        telemetryReporter,
        {
          storeMonitor: mStoreMonitor,
          providerMonitor: mProviderMonitor,
          autoScannerMonitor: mAutoScannerMonitor,
          diagnosticsMonitor: mDiagnosticsMonitor,
          decorationMonitor: mDecorationMonitor,
          folderMonitor: mFolderMonitor,
          pipelineMonitor: mPipelineMonitor,
          runtimeAssertions: mRuntimeAssertions,
          snapshotSystem: mSnapshotSystem,
          timelineGenerator: mTimelineGenerator,
          fileLogger: fileLogger ?? undefined,
          performanceMonitor: mPerfMonitor,
        },
      );
      try {
        const extVersion = context.extension.packageJSON.version ?? 'unknown';
        mDevDashboard.setVersions(extVersion, vscode.version);
      } catch { /* non-critical */ }

      // Auto-reveal dashboard on assertion failures for live debugging
      telemetryReporter.subscribe('assertion.failure', () => {
        mDevDashboard.notifyAssertion();
      });

      // Assign to outer variables
      storeMonitor = mStoreMonitor;
      providerMonitor = mProviderMonitor;
      autoScannerMonitor = mAutoScannerMonitor;
      diagnosticsMonitor = mDiagnosticsMonitor;
      decorationMonitor = mDecorationMonitor;
      folderMonitor = mFolderMonitor;
      pipelineMonitor = mPipelineMonitor;
      timerMonitor = mTimerMonitor;
      perfMonitor = mPerfMonitor;
      runtimeAssertions = mRuntimeAssertions;
      timelineGenerator = mTimelineGenerator;
      snapshotSystem = mSnapshotSystem;
      devDashboard = mDevDashboard;

      log('[TELEMETRY] Full monitoring: all monitors, dashboard, assertions active');
    } else {
      log('[TELEMETRY] Minimal monitoring: monitors, dashboard, assertions disabled');
    }

    const tscProvider = new TscDiagnosticProvider(problemStore, {
      timeoutMs: configManager.getConfig().typescript.timeout,
    });
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

    // Apply user config before initializing providers so the initial
    // scan respects enabled/disabled state, timeout, etc.
    const applyConfig = (): void => {
      const config = configManager.getConfig();
      diagProvider.setSeverityOverrides(config.severityOverrides);
      diagProvider.setIgnorePatterns(config.ignorePatterns);
      tscProvider.updateConfig(config.typescript);
      eslintProvider.updateConfig(config.eslint);
    };
    applyConfig();

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
    log('[FORENSIC:Step7] provider onDidChangeFileDecorations is Event: ' + (typeof decorationEngine.onDidChangeFileDecorations === 'function' ? 'YES' : 'NO'));
    // Force an initial full refresh so VS Code queries decorations for all visible files
    setTimeout(() => {
      decorationEngine.fireDidChange(undefined);
      log('[FORENSIC:Step7] fired initial full refresh (undefined)');
    }, 100);

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
      diagProviderManager,
      vsDiagnosticsProvider,
      decorationEngine,
      apiManager,
      { dispose: () => { /* TelemetryConfigManager has no dispose */ } },
      telemetryReporter,
      ...(storeMonitor ? [storeMonitor] : []),
      ...(providerMonitor ? [providerMonitor] : []),
      ...(autoScannerMonitor ? [autoScannerMonitor] : []),
      ...(diagnosticsMonitor ? [diagnosticsMonitor] : []),
      ...(decorationMonitor ? [decorationMonitor] : []),
      ...(folderMonitor ? [folderMonitor] : []),
      ...(pipelineMonitor ? [pipelineMonitor] : []),
      ...(timerMonitor ? [timerMonitor] : []),
      ...(perfMonitor ? [perfMonitor] : []),
      ...(timelineGenerator ? [timelineGenerator] : []),
      ...(snapshotSystem ? [snapshotSystem] : []),
      ...(devDashboard ? [devDashboard] : []),
      ...(telemetryFileLogger ? [telemetryFileLogger] : []),
      ...(fileLogger ? [{ dispose: () => { fileLogger.close(); } }] : []),
      { dispose: () => { trendTracker.stop(); } },
    );

    // TEST COMMAND - shows notification immediately
    context.subscriptions.push(
      vscode.commands.registerCommand('problemExplorer.test', () => {
        log('TEST COMMAND RUN');
        vscode.window.showInformationMessage('Problem Explorer: TEST COMMAND WORKS!');
      }),
    );

    log('===== ACTIVATE COMPLETE =====');
    vscode.window.showInformationMessage('Problem Explorer: ACTIVATED!');

    // Full monitoring only — dashboard command, assertions, telemetry editor
    if (runtimeAssertions) {
      // DEVELOPER DASHBOARD COMMAND
      if (devDashboard) {
        context.subscriptions.push(
          vscode.commands.registerCommand('problemExplorer.openDeveloperDashboard', () => {
            devDashboard.show();
            log('[TELEMETRY] Developer Dashboard opened');
          }),
        );
      }

      // Register all domain assertion rules
      runtimeAssertions.registerStoreAssertions(problemStore, diagProviderManager);
      runtimeAssertions.registerProviderAssertions(diagProviderManager, problemStore);
      runtimeAssertions.registerDiagnosticsAssertions(diagnosticsMonitor!, problemStore);
      runtimeAssertions.registerDecorationAssertions(decorationMonitor!, problemStore);
      runtimeAssertions.registerFolderAssertions(folderStatusManager, problemStore);
      runtimeAssertions.registerPipelineAssertions(pipelineMonitor!);
      runtimeAssertions.registerSystemHealthAssertions(
        () => getTelemetryBus().getTelemetryErrorCount(),
        () => ({
          ...perfMonitor!.getInternalStateSizes(),
          ...pipelineMonitor!.getInternalStateSizes(),
          ...diagnosticsMonitor!.getInternalStateSizes(),
          ...storeMonitor!.getInternalStateSizes(),
          ...providerMonitor!.getInternalStateSizes(),
          ...autoScannerMonitor!.getInternalStateSizes(),
          ...decorationMonitor!.getInternalStateSizes(),
          ...timelineGenerator!.getInternalStateSizes(),
          ...runtimeAssertions.engine.getInternalStateSizes(),
        }),
      );

      // Set up recovery handlers
      runtimeAssertions.engine.setRecoveryHandlers({
        notifyDashboard: () => { try { devDashboard!.notifyAssertion(); } catch { /* dashboard may be disposed */ } },
        requestSnapshot: () => {
          const snapshot = snapshotSystem!.captureManual();
          log(`[ASSERTION] Snapshot ${snapshot.metadata.id} captured with ${Object.keys(snapshot.data).length} data sections`);
        },
        stopPipeline: (pipelineId?: string) => {
          if (pipelineId) {
            pipelineMonitor!.cancelExecution(pipelineId as PipelineId, 'Assertion failure recovery');
            log(`[ASSERTION] Pipeline ${pipelineId} stopped via recovery`);
          }
        },
        autoRecover: (_rule: string) => {
          log(`[ASSERTION] Auto-recovery triggered for rule: ${_rule}`);
        },
      });

      // Periodic runtime assertions every 30s
      const assertionInterval = setInterval(async () => {
        const results = await runtimeAssertions.engine.executeAll();
        const failed = results.filter((r) => !r.passed);
        if (failed.length > 0) {
          log(`[ASSERTION] ${failed.length} assertion(s) failed out of ${results.length} executed`);
        }
      }, 30000);
      context.subscriptions.push({ dispose: () => clearInterval(assertionInterval) });

      // TELEMETRY LOG CUSTOM EDITOR
      context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
          TelemetryLogEditorProvider.viewType,
          new TelemetryLogEditorProvider(context.extensionUri),
        ),
      );

      // OFFLINE FORENSIC ANALYSIS COMMAND — run TimelineGenerator against saved telemetry log
      context.subscriptions.push(
        vscode.commands.registerCommand('problemExplorer.analyzeTelemetryLog', async () => {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'Telemetry Logs': ['jsonl', 'log', 'txt'] },
            openLabel: 'Analyze',
          });
          if (!uris || uris.length === 0) return;
          const filePath = uris[0].fsPath;
          log(`[TELEMETRY] Analyzing log file: ${filePath}`);
          const report = TimelineGenerator.analyzeLogFile(filePath);
          log(report);
          vscode.window.showInformationMessage('Telemetry log analysis complete — see output channel');
        }),
      );
    }

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
