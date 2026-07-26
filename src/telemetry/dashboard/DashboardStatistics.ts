import type { DashboardSnapshot, SystemOverviewData } from './DashboardTypes';

/* ------------------------------------------------------------------ */
/*  DashboardStatistics — Data aggregation & caching                   */
/* ------------------------------------------------------------------ */

export class DashboardStatistics {
  private snapshotCache: DashboardSnapshot | undefined;
  private lastSnapshotTime = 0;
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs: number = 1000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /* ------------------------------------------------------------------ */
  /*  Data providers (set by Dashboard on init)                          */
  /* ------------------------------------------------------------------ */

  private overviewProviders: (() => SystemOverviewData)[] = [];
  private panelProviders = new Map<string, () => unknown>();

  setOverviewProviders(providers: (() => SystemOverviewData)[]): void {
    this.overviewProviders = providers;
  }

  setPanelProvider(panel: string, provider: () => unknown): void {
    this.panelProviders.set(panel, provider);
  }

  /* ------------------------------------------------------------------ */
  /*  Snapshot creation                                                 */
  /* ------------------------------------------------------------------ */

  captureSnapshot(): DashboardSnapshot {
    const start = Date.now();
    console.log('[TRACE-A1] captureSnapshot ENTER');
    const now = Date.now();
    if (this.snapshotCache && (now - this.lastSnapshotTime) < this.cacheTtlMs) {
      console.log('[TRACE-A1] captureSnapshot EXIT (cache hit), age:', now - this.lastSnapshotTime, 'ms');
      return this.snapshotCache;
    }

    console.log('[TRACE-A1] cache miss, collecting overview...');
    const overview = this.collectOverview();
    console.log('[TRACE-A1] overview collected, type:', typeof overview, 'keys:', overview ? Object.keys(overview).join(',') : 'null');

    const panels: DashboardSnapshot['panels'] = {};

    for (const [panel, provider] of this.panelProviders) {
      try {
        panels[panel as keyof typeof panels] = provider();
      } catch {
        /* skip failed providers */
      }
    }

    this.snapshotCache = { timestamp: now, overview, panels };
    this.lastSnapshotTime = now;
    console.log('[TRACE-A1] captureSnapshot EXIT, duration:', Date.now() - start, 'ms');
    return this.snapshotCache;
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private collectOverview(): SystemOverviewData {
    const start = Date.now();
    console.log('[TRACE-A2] collectOverview ENTER, providers:', this.overviewProviders.length);
    const result: SystemOverviewData = {
      extensionVersion: '',
      vscodeVersion: '',
      uptimeSec: 0,
      activeProviders: 0,
      activeScans: 0,
      activePipelines: 0,
      snapshotCount: 0,
      assertionFailures: 0,
      healthScore: 100,
      healthLevel: 'healthy',
      totalEventsProcessed: 0,
      telemetryErrorCount: 0,
      totalErrors: 0,
      memoryMb: 0,
    };

    for (let i = 0; i < this.overviewProviders.length; i++) {
      const provider = this.overviewProviders[i];
      try {
        console.log('[TRACE-A2] calling overview provider', i);
        const data = provider();
        console.log('[TRACE-A2] provider', i, 'returned, type:', typeof data, 'keys:', data ? Object.keys(data).join(',') : 'null');
        Object.assign(result, data);
      } catch (e) {
        console.log('[TRACE-A2] provider', i, 'THREW:', e instanceof Error ? e.message : String(e));
      }
    }

    console.log('[TRACE-A2] collectOverview EXIT, duration:', Date.now() - start, 'ms');
    return result;
  }

  invalidateCache(): void {
    this.snapshotCache = undefined;
    this.lastSnapshotTime = 0;
  }

  dispose(): void {
    this.snapshotCache = undefined;
    this.overviewProviders = [];
    this.panelProviders.clear();
  }
}
