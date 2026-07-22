import type { TelemetryReporter } from '../TelemetryReporter';
import type { TelemetryEvent } from '../TelemetryEvent';
import type {
  DashboardControllerApi,
  DashboardViewApi,
  DashboardMessage,
  DashboardFilter,
  DashboardPanelType,
} from './DashboardTypes';

/* ------------------------------------------------------------------ */
/*  DashboardController — business logic layer                         */
/* ------------------------------------------------------------------ */

export type ExportHandler = (scope: DashboardPanelType, format: 'json' | 'csv' | 'text') => Promise<string>;

export class DashboardController implements DashboardControllerApi {
  private view: DashboardViewApi | undefined;
  private readonly dataCache = new Map<string, unknown>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setInterval>>();
  private currentFilter: DashboardFilter = {};
  private disposed = false;

  constructor(
    private readonly reporter: TelemetryReporter,
    private readonly dataProviders: Map<DashboardPanelType, () => unknown>,
    private readonly exportHandler?: ExportHandler,
    private readonly refreshIntervalMs: number = 2000,
  ) {
    this.reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      this.handleLiveEvent(event);
    });
  }

  setView(view: DashboardViewApi): void {
    this.view = view;
  }

  handleMessage(message: DashboardMessage): void {
    if (this.disposed) return;

    switch (message.type) {
      case 'navigate':
        this.onNavigate(message.panel);
        break;
      case 'setFilter':
        this.currentFilter = message.filter;
        break;
      case 'requestData':
        this.collectAndSend(message.panel);
        break;
      case 'requestExport':
        this.handleExport(message.scope, message.format);
        break;
      case 'refresh':
        this.refreshAll();
        break;
      case 'viewReady':
        console.log('[Dashboard] viewReady received from webview');
        this.refreshAll();
        break;
      default:
        break;
    }
  }

  refreshAll(): void {
    if (!this.view) return;
    for (const panel of this.dataProviders.keys()) {
      this.collectAndSend(panel);
    }
  }

  private onNavigate(panel: DashboardPanelType): void {
    this.ensureRefreshTimer(panel);
    this.collectAndSend(panel);
  }

  private collectAndSend(panel: DashboardPanelType): void {
    if (!this.view) return;

    try {
      const provider = this.dataProviders.get(panel);
      if (!provider) return;

      const raw = provider();
      const filtered = this.applyFilter(raw, this.currentFilter);
      this.dataCache.set(panel, filtered);

      this.view.postMessage({ type: 'dataUpdate', panel, data: filtered });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.view.postMessage({ type: 'error', message: msg });
    }
  }

  private applyFilter(data: unknown, _filter: DashboardFilter): unknown {
    return data;
  }

  private ensureRefreshTimer(panel: DashboardPanelType): void {
    if (this.refreshTimers.has(panel)) return;

    const timer = setInterval(() => {
      if (this.disposed) {
        clearInterval(timer);
        this.refreshTimers.delete(panel);
        return;
      }
      this.collectAndSend(panel);
    }, this.refreshIntervalMs);

    this.refreshTimers.set(panel, timer);
  }

  private async handleExport(scope: DashboardPanelType, format: 'json' | 'csv' | 'text'): Promise<void> {
    if (!this.exportHandler || !this.view) return;

    try {
      const resultPath = await this.exportHandler(scope, format);
      this.view.postMessage({
        type: 'dataUpdate',
        panel: 'export',
        data: { exported: true, path: resultPath, scope, format },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.view.postMessage({ type: 'error', message: `Export failed: ${msg}` });
    }
  }

  private handleLiveEvent(_event: TelemetryEvent): void {
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.refreshTimers.values()) {
      clearInterval(timer);
    }
    this.refreshTimers.clear();
    this.dataCache.clear();
    this.view = undefined;
  }
}
