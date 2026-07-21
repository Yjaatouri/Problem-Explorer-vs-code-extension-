import * as vscode from 'vscode';
import { DashboardController } from './DashboardController';
import { DashboardView } from './DashboardView';
import { DashboardStatistics } from './DashboardStatistics';
import type { TelemetryReporter } from '../TelemetryReporter';
import type {
  DashboardOptions,
  DashboardPanelType,
  DashboardMessage,
} from './DashboardTypes';
import { DEFAULT_DASHBOARD_OPTIONS } from './DashboardTypes';

/* ------------------------------------------------------------------ */
/*  Dashboard — Main orchestrator                                      */
/* ------------------------------------------------------------------ */

export class Dashboard {
  private readonly view: DashboardView;
  private readonly controller: DashboardController;
  private readonly statistics: DashboardStatistics;
  private readonly options: DashboardOptions;
  private disposed = false;

  constructor(
    extensionUri: vscode.Uri,
    reporter: TelemetryReporter,
    options: Partial<DashboardOptions> = {},
  ) {
    this.options = { ...DEFAULT_DASHBOARD_OPTIONS, ...options };

    this.view = new DashboardView(extensionUri);
    this.statistics = new DashboardStatistics(this.options.autoRefreshIntervalMs);

    /* Build data provider map */
    const dataProviders = new Map<DashboardPanelType, () => unknown>();
    dataProviders.set('overview', () => this.statistics.captureSnapshot().overview);
    this.registerPanelProviders(dataProviders);

    this.controller = new DashboardController(
      reporter,
      dataProviders,
      this.options.autoRefreshIntervalMs,
    );

    this.controller.setView(this.view);
    this.view.setMessageHandler((msg: DashboardMessage) => this.controller.handleMessage(msg));
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  show(): void {
    this.view.show();
  }

  notifyAssertion(): void {
    this.controller.handleMessage({ type: 'navigate', panel: 'assertions' });
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
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  private registerPanelProviders(dataProviders: Map<DashboardPanelType, () => unknown>): void {
    const panels: DashboardPanelType[] = [
      'store', 'provider', 'autoscanner', 'diagnostics',
      'folder', 'decoration', 'pipeline', 'assertions',
      'snapshots', 'timeline', 'filelogger', 'performance',
    ];

    for (const panel of panels) {
      dataProviders.set(panel, () => this.collectPanelData(panel));
    }
  }

  private collectPanelData(panel: DashboardPanelType): unknown {
    /* T3+ — each panel will query its monitor for live data */
    return { panel, status: 'pending', message: `Data collection for ${panel} not yet implemented` };
  }
}
