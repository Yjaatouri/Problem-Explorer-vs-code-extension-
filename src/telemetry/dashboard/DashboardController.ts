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

export class DashboardController implements DashboardControllerApi {
  private view: DashboardViewApi | undefined;
  private readonly dataCache = new Map<string, unknown>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setInterval>>();
  private currentFilter: DashboardFilter = {};
  private disposed = false;

  constructor(
    private readonly reporter: TelemetryReporter,
    private readonly dataProviders: Map<DashboardPanelType, () => unknown>,
    private readonly refreshIntervalMs: number = 2000,
  ) {
    /* Subscribe to telemetry bus for live push updates */
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
        this.onNavigate(this.getCurrentPanel());
        break;
      case 'requestData':
        this.collectAndSend(message.panel);
        break;
      case 'refresh':
        this.refreshAll();
        break;
      case 'viewReady':
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

  private getCurrentPanel(): DashboardPanelType {
    return 'overview';
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
    /* T8 — filtering logic will be expanded here */
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

  private handleLiveEvent(_event: TelemetryEvent): void {
    /* T2+ — incremental updates on live events */
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
