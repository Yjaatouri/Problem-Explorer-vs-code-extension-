import * as vscode from 'vscode';
import { DashboardController } from './DashboardController';
import { DashboardView } from './DashboardView';
import { DashboardStatistics } from './DashboardStatistics';
import type { TelemetryReporter } from '../TelemetryReporter';
import { getTelemetryBus } from '../TelemetryBus';
import type {
  DashboardOptions,
  DashboardPanelType,
  DashboardMessage,
  SystemOverviewData,
} from './DashboardTypes';
import { DEFAULT_DASHBOARD_OPTIONS } from './DashboardTypes';
import type { EventPipelineMonitor } from '../monitors/EventPipelineMonitor';
import type { RuntimeAssertions } from '../monitors/RuntimeAssertions';
import type { SnapshotSystem } from '../monitors/SnapshotSystem';
import type { PerformanceMonitor } from '../monitors/PerformanceMonitor';
import type { AutoScannerMonitor } from '../monitors/AutoScannerMonitor';
import type { ProviderMonitor } from '../monitors/ProviderMonitor';
import type { DiagnosticsMonitor } from '../monitors/DiagnosticsMonitor';
import type { DecorationMonitor } from '../monitors/DecorationMonitor';
import type { FolderMonitor } from '../monitors/FolderMonitor';
import type { StoreMonitor } from '../monitors/StoreMonitor';
import type { TimelineGenerator } from '../monitors/TimelineGenerator';
import type { FileLogger } from '../monitors/FileLogger';

/* ------------------------------------------------------------------ */
/*  Dashboard — Main orchestrator                                      */
/* ------------------------------------------------------------------ */

export interface DashboardMonitorRefs {
  readonly storeMonitor: StoreMonitor;
  readonly providerMonitor: ProviderMonitor;
  readonly autoScannerMonitor: AutoScannerMonitor;
  readonly diagnosticsMonitor: DiagnosticsMonitor;
  readonly decorationMonitor: DecorationMonitor;
  readonly folderMonitor: FolderMonitor;
  readonly pipelineMonitor: EventPipelineMonitor;
  readonly runtimeAssertions: RuntimeAssertions;
  readonly snapshotSystem: SnapshotSystem;
  readonly timelineGenerator: TimelineGenerator;
  readonly fileLogger?: FileLogger;
  readonly performanceMonitor: PerformanceMonitor;
}

export class Dashboard {
  private readonly view: DashboardView;
  private readonly controller: DashboardController;
  private readonly statistics: DashboardStatistics;
  private readonly options: DashboardOptions;
  private readonly monitors: DashboardMonitorRefs;
  private readonly startedAt = Date.now();
  private disposed = false;
  private extensionVersion = '';
  private vscodeVersion = '';

  constructor(
    extensionUri: vscode.Uri,
    reporter: TelemetryReporter,
    monitors: DashboardMonitorRefs,
    options: Partial<DashboardOptions> = {},
  ) {
    this.options = { ...DEFAULT_DASHBOARD_OPTIONS, ...options };
    this.monitors = monitors;
    this.view = new DashboardView(extensionUri);
    this.statistics = new DashboardStatistics(this.options.autoRefreshIntervalMs);

    this.statistics.setOverviewProviders([
      () => this.collectOverviewData(),
    ]);

    /* Build data provider map */
    const dataProviders = new Map<DashboardPanelType, () => unknown>();
    this.registerDataProviders(dataProviders);

    this.controller = new DashboardController(
      reporter,
      dataProviders,
      (scope, format) => this.handleExport(scope, format),
      this.options.autoRefreshIntervalMs,
    );

    this.controller.setView(this.view);
    this.view.setMessageHandler((msg: DashboardMessage) => this.controller.handleMessage(msg));
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  show(): void {
    console.log('[Dashboard-F0] Dashboard.show() ENTER');
    this.view.show();
    console.log('[Dashboard-F0] Dashboard.show() EXIT');
  }

  notifyAssertion(): void {
    this.controller.handleMessage({ type: 'navigate', panel: 'assertions' });
  }

  setVersions(extensionVersion: string, vscodeVersion: string): void {
    this.extensionVersion = extensionVersion;
    this.vscodeVersion = vscodeVersion;
  }

  private async handleExport(scope: DashboardPanelType, format: 'json' | 'csv' | 'text'): Promise<string> {
    const defaultName = `${scope}-${new Date().toISOString().slice(0, 19)}.${format}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: { 'Exported Data': [format] },
    });
    if (!uri) throw new Error('Export cancelled');

    const fs = await import('fs');

    switch (scope) {
      case 'overview': {
        const data = this.collectOverviewData();
        fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
        break;
      }
      case 'performance': {
        const data = this.monitors.performanceMonitor.getStatistics();
        fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
        break;
      }
      case 'assertions': {
        const engine = this.monitors.runtimeAssertions.engine;
        const data = { statistics: engine.getStatistics(), failures: engine.getFailures(), rules: engine.getAllRules() };
        fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
        break;
      }
      case 'snapshots': {
        const system = this.monitors.snapshotSystem;
        fs.writeFileSync(uri.fsPath, system.exportAllSnapshots(true), 'utf8');
        break;
      }
      case 'timeline': {
        const gen = this.monitors.timelineGenerator;
        const data = {
          statistics: gen.getStatistics(),
          live: gen.getLiveTimelines(),
          historical: gen.getHistoricalTimelines(),
          failed: gen.getFailedTimelines(),
        };
        fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
        break;
      }
      default: {
        /* For individual monitor panels, collect their data provider output */
        const provider = this.getDataProvider(scope);
        const data = provider ? provider() : { scope, note: 'No data available' };
        fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
        break;
      }
    }

    return uri.fsPath;
  }

  private getDataProvider(panel: DashboardPanelType): (() => unknown) | undefined {
    const map = new Map<DashboardPanelType, () => unknown>();
    this.registerDataProviders(map);
    return map.get(panel);
  }

  refresh(): void {
    this.statistics.invalidateCache();
    this.controller.refreshAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.dispose();
    this.view.dispose();
    this.statistics.dispose();
  }

  /* ------------------------------------------------------------------ */
  /*  Overview Data                                                      */
  /* ------------------------------------------------------------------ */

  private collectOverviewData(): SystemOverviewData {
    let activeProviders = 0;
    try { activeProviders = this.monitors.providerMonitor.getAllStatistics().size; } catch { /* ok */ }

    let activeScans = 0;
    try { activeScans = this.monitors.autoScannerMonitor.getStatistics().totalFlushes; } catch { /* ok */ }

    let activePipelines = 0;
    try {
      const pipelineStats = this.monitors.pipelineMonitor.getStatistics();
      activePipelines = pipelineStats.activeExecutions ?? 0;
    } catch { /* ok */ }

    let snapshotCount = 0;
    try { snapshotCount = this.monitors.snapshotSystem.listSnapshots().length; } catch { /* ok */ }

    let assertionFailures = 0;
    try { assertionFailures = this.monitors.runtimeAssertions.engine.getFailures().length; } catch { /* ok */ }

    let healthScore = 100;
    let healthLevel = 'healthy';
    try {
      const perfStats = this.monitors.performanceMonitor.getStatistics();
      healthScore = perfStats.health.score;
      healthLevel = perfStats.health.level;
    } catch { /* ok */ }

    let totalEventsProcessed = 0;
    try { totalEventsProcessed = this.monitors.performanceMonitor.getStatistics().totalSamples; } catch { /* ok */ }

    let memoryMb = 0;
    try {
      const perfStats = this.monitors.performanceMonitor.getStatistics();
      memoryMb = perfStats.resources.memoryMb;
    } catch { /* ok */ }

    let telemetryErrorCount = 0;
    try { telemetryErrorCount = getTelemetryBus().getTelemetryErrorCount(); } catch { /* ok */ }

    return {
      extensionVersion: this.extensionVersion,
      vscodeVersion: this.vscodeVersion,
      uptimeSec: (Date.now() - this.startedAt) / 1000,
      activeProviders,
      activeScans,
      activePipelines,
      snapshotCount,
      assertionFailures,
      healthScore,
      healthLevel,
      totalEventsProcessed,
      telemetryErrorCount,
      totalErrors: 0,
      memoryMb,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Panel Data Providers                                               */
  /* ------------------------------------------------------------------ */

  private registerDataProviders(dataProviders: Map<DashboardPanelType, () => unknown>): void {
    dataProviders.set('overview', () => this.statistics.captureSnapshot().overview);

    dataProviders.set('store', () => this.collectStoreData());
    dataProviders.set('provider', () => this.collectProviderData());
    dataProviders.set('autoscanner', () => this.collectAutoScannerData());
    dataProviders.set('diagnostics', () => this.collectDiagnosticsData());
    dataProviders.set('folder', () => this.collectFolderData());
    dataProviders.set('decoration', () => this.collectDecorationData());
    dataProviders.set('pipeline', () => this.collectPipelineData());
    dataProviders.set('assertions', () => this.collectAssertionsData());
    dataProviders.set('snapshots', () => this.collectSnapshotsData());
    dataProviders.set('timeline', () => this.collectTimelineData());
    dataProviders.set('filelogger', () => this.collectFileLoggerData());
    dataProviders.set('performance', () => this.collectPerformanceData());
  }

  private collectStoreData(): unknown {
    try { return this.monitors.storeMonitor.capturePerformanceSnapshot(); } catch { return { error: 'store unavailable' }; }
  }

  private collectProviderData(): unknown {
    try {
      const allStats = this.monitors.providerMonitor.getAllStatistics();
      const allSnapshots = this.monitors.providerMonitor.getAllSnapshots();
      return { statistics: [...allStats.entries()].map(([k, v]) => ({ name: k, ...v })), snapshots: allSnapshots };
    } catch { return { error: 'provider unavailable' }; }
  }

  private collectAutoScannerData(): unknown {
    try { return this.monitors.autoScannerMonitor.getStatistics(); } catch { return { error: 'autoscanner unavailable' }; }
  }

  private collectDiagnosticsData(): unknown {
    try { return this.monitors.diagnosticsMonitor.getStatistics(); } catch { return { error: 'diagnostics unavailable' }; }
  }

  private collectFolderData(): unknown {
    try { return this.monitors.folderMonitor.getStatistics(); } catch { return { error: 'folder unavailable' }; }
  }

  private collectDecorationData(): unknown {
    try { return this.monitors.decorationMonitor.getStatistics(); } catch { return { error: 'decoration unavailable' }; }
  }

  private collectPipelineData(): unknown {
    try { return this.monitors.pipelineMonitor.getStatistics(); } catch { return { error: 'pipeline unavailable' }; }
  }

  private collectAssertionsData(): unknown {
    try {
      const engine = this.monitors.runtimeAssertions.engine;
      return {
        statistics: engine.getStatistics(),
        failures: engine.getFailures(),
        rules: engine.getAllRules().map(r => ({ name: r.name, enabled: r.enabled, category: r.category, severity: r.severity })),
      };
    } catch { return { error: 'assertions unavailable' }; }
  }

  private collectSnapshotsData(): unknown {
    try {
      const system = this.monitors.snapshotSystem;
      return {
        snapshots: system.listSnapshots(),
        statistics: system.getStatistics(),
      };
    } catch { return { error: 'snapshots unavailable' }; }
  }

  private collectTimelineData(): unknown {
    try {
      const gen = this.monitors.timelineGenerator;
      return {
        statistics: gen.getStatistics(),
        live: gen.getLiveTimelines(),
        historical: gen.getHistoricalTimelines(),
        failed: gen.getFailedTimelines(),
      };
    } catch { return { error: 'timeline unavailable' }; }
  }

  private collectFileLoggerData(): unknown {
    try {
      const logger = this.monitors.fileLogger;
      if (!logger) return { status: 'unavailable', message: 'FileLogger not initialized' };
      return {
        statistics: logger.getStatistics(),
        currentSession: logger.getCurrentSession(),
        sessions: logger.getSessions(),
      };
    } catch { return { error: 'filelogger unavailable' }; }
  }

  private collectPerformanceData(): unknown {
    try { return this.monitors.performanceMonitor.getStatistics(); } catch { return { error: 'performance unavailable' }; }
  }
}
