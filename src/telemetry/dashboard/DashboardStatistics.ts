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
    const now = Date.now();
    if (this.snapshotCache && (now - this.lastSnapshotTime) < this.cacheTtlMs) {
      return this.snapshotCache;
    }

    const overview = this.collectOverview();
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
    return this.snapshotCache;
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private collectOverview(): SystemOverviewData {
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
      totalErrors: 0,
      memoryMb: 0,
    };

    for (const provider of this.overviewProviders) {
      try {
        const data = provider();
        Object.assign(result, data);
      } catch {
        /* skip failed providers */
      }
    }

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
