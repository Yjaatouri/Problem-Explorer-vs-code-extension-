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
    const start = Date.now();
    console.log('[TRACE-B1] handleMessage ENTER:', message.type, 'disposed:', this.disposed, 'view:', !!this.view);
    if (this.disposed) {
      console.log('[TRACE-B1] handleMessage EXIT (disposed)');
      return;
    }

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
        console.log('[TRACE-B1] viewReady received, calling refreshAll');
        this.refreshAll();
        console.log('[TRACE-B1] viewReady handler done');
        break;
      case 'webviewReady':
        console.log('[WEBVIEW-STARTUP] webviewReady received, timestamp:', message.timestamp);
        break;
      case 'webviewError':
        console.error('[WEBVIEW-ERROR]', message.message);
        if (message.stack) console.error('[WEBVIEW-ERROR-STACK]', message.stack);
        break;
      case 'diagStoreData':
        console.log('[STORE-DIAG] Webview received store data:', 'hasData:', message.hasData, 'type:', message.dataType, 'keys:', message.keys);
        break;
      default:
        break;
    }
    console.log('[TRACE-B1] handleMessage EXIT, duration:', Date.now() - start, 'ms, type:', message.type);
  }

  refreshAll(): void {
    const start = Date.now();
    console.log('[TRACE-B2] refreshAll ENTER, view:', !!this.view, 'providers:', this.dataProviders.size);
    if (!this.view) {
      console.log('[TRACE-B2] refreshAll EXIT early — no view');
      return;
    }
    let sent = 0;
    const panels: string[] = [];
    for (const panel of this.dataProviders.keys()) {
      panels.push(panel);
    }
    console.log('[TRACE-B2] panel order:', panels.join(','));
    for (const panel of this.dataProviders.keys()) {
      console.log('[TRACE-B2] calling collectAndSend for:', panel);
      this.collectAndSend(panel);
      sent++;
      console.log('[TRACE-B2] collectAndSend completed for:', panel);
    }
    console.log('[TRACE-B2] refreshAll EXIT, sent:', sent, 'duration:', Date.now() - start, 'ms');
  }

  private onNavigate(panel: DashboardPanelType): void {
    const start = Date.now();
    console.log('[TRACE-B4] onNavigate ENTER for:', panel);
    this.ensureRefreshTimer(panel);
    this.collectAndSend(panel);
    console.log('[TRACE-B4] onNavigate EXIT for:', panel, 'duration:', Date.now() - start, 'ms');
  }

  private collectAndSend(panel: DashboardPanelType): void {
    const start = Date.now();
    console.log('[TRACE-B3] collectAndSend ENTER for:', panel);
    if (!this.view) {
      console.log('[TRACE-B3] collectAndSend EXIT early — no view');
      return;
    }

    try {
      const provider = this.dataProviders.get(panel);
      if (!provider) {
        console.log('[TRACE-B3] collectAndSend SKIP — no provider for:', panel);
        return;
      }

      console.log('[TRACE-B3] calling provider for:', panel);
      const raw = provider();
      console.log('[TRACE-B3] provider returned for:', panel, 'type:', typeof raw, 'value:', raw === undefined ? 'undefined' : raw === null ? 'null' : typeof raw === 'object' ? 'object(' + (raw as Record<string, unknown>).error + ')' : String(raw).substring(0, 100));
      const filtered = this.applyFilter(raw, this.currentFilter);
      this.dataCache.set(panel, filtered);

      console.log('[TRACE-B3] posting message for:', panel);
      const result = this.view.postMessage({ type: 'dataUpdate', panel, data: filtered });
      console.log('[TRACE-B3] postMessage returned:', result, 'for:', panel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('[TRACE-B3] collectAndSend ERROR for:', panel, msg);
      console.log('[TRACE-B3] stack:', err instanceof Error ? err.stack : '');
      try {
        this.view.postMessage({ type: 'error', message: msg });
        console.log('[TRACE-B3] error message posted');
      } catch (e2) {
        console.log('[TRACE-B3] FAILED to post error message:', e2);
      }
    }
    console.log('[TRACE-B3] collectAndSend EXIT for:', panel, 'duration:', Date.now() - start, 'ms');
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
