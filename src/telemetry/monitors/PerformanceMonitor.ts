import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/** In-flight save-to-decoration chain */
interface SaveChain {
  readonly uri: string;
  readonly startedAt: number;
  flushed: boolean;
  decorated: boolean;
}

/** In-flight refresh-to-decoration chain */
interface RefreshChain {
  readonly provider: string;
  readonly startedAt: number;
  decorated: boolean;
}

/** Structured event payload for end-to-end latency measurement */
export interface PerformanceLatencyEventData {
  readonly type: 'perf.latency';
  readonly metric: string;
  readonly valueMs: number;
  readonly sourceEvent: string;
  readonly provider?: string;
  readonly uri?: string;
}

/** Union of all performance monitor event types */
export type PerformanceMonitorEvent = PerformanceLatencyEventData;

const SAVE_WINDOW_MS = 30000;
const REFRESH_WINDOW_MS = 60000;
const MAX_PENDING = 500;

/** Monitors end-to-end latency: aggregates sub-measurements and measures cross-pipeline duration */
export class PerformanceMonitor {
  private readonly pendingSaves: SaveChain[] = [];
  private readonly pendingRefreshes: RefreshChain[] = [];
  private disposed = false;
  private subscription: TelemetrySubscription | undefined;

  constructor(private readonly reporter: TelemetryReporter) {
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('perf.') || event.type.startsWith('pipeline.')) return;
      try {
        this.processEvent(event);
      } catch {
        // swallow per-event errors
      }
    });
  }

  private processEvent(event: TelemetryEvent): void {
    switch (event.type) {
      // ── Pipeline seeds ──
      case 'autoscan.fileSaved': {
        this.pendingSaves.push({
          uri: (event as any).uri as string,
          startedAt: event.timestamp,
          flushed: false,
          decorated: false,
        });
        if (this.pendingSaves.length > MAX_PENDING) this.pendingSaves.shift();
        break;
      }

      case 'provider.lifecycle': {
        const evt = event as any;
        if (evt.phase === 'start' || evt.phase === 'initialize') {
          this.pendingRefreshes.push({
            provider: evt.provider as string,
            startedAt: event.timestamp,
            decorated: false,
          });
          if (this.pendingRefreshes.length > MAX_PENDING) this.pendingRefreshes.shift();
        }
        break;
      }

      // ── Sub-measurement extraction ──
      case 'provider.scan': {
        const evt = event as any;
        if (evt.phase === 'end' && typeof evt.executionTimeMs === 'number') {
          this.reportLatency('providerScan', evt.executionTimeMs, 'provider.scan.end', evt.provider);
        }
        break;
      }

      case 'store.set':
      case 'store.delete':
      case 'store.clear': {
        const evt = event as any;
        if (typeof evt.executionTimeMs === 'number') {
          this.reportLatency('storeUpdate', evt.executionTimeMs, event.type, evt.provider);
        }
        break;
      }

      case 'folder.updateAncestors': {
        const evt = event as any;
        if (typeof evt.executionTimeMs === 'number') {
          this.reportLatency('folderUpdate', evt.executionTimeMs, event.type, undefined, evt.uri);
        }
        break;
      }

      case 'folder.rebuildAll': {
        const evt = event as any;
        if (typeof evt.executionTimeMs === 'number') {
          this.reportLatency('folderRebuildAll', evt.executionTimeMs, event.type);
        }
        break;
      }

      case 'decoration.provideFileDecoration': {
        const evt = event as any;
        if (typeof evt.executionTimeMs === 'number') {
          this.reportLatency('decorationProvide', evt.executionTimeMs, event.type, undefined, evt.uri);
        }
        this.matchDecoration(evt.uri as string | undefined);
        break;
      }

      case 'decoration.fireDidChange': {
        const evt = event as any;
        if (typeof evt.executionTimeMs === 'number') {
          this.reportLatency('decorationFireDidChange', evt.executionTimeMs, event.type);
        }
        break;
      }

      case 'timer.executed': {
        const evt = event as any;
        if (typeof evt.callbackDuration === 'number' && evt.callbackDuration > 50) {
          this.reportLatency('timerCallback', evt.callbackDuration, event.type);
        }
        break;
      }

      case 'diagnostics.change': {
        const evt = event as any;
        if (typeof evt.executionTimeMs === 'number') {
          this.reportLatency('diagnosticsChange', evt.executionTimeMs, event.type);
        }
        break;
      }
    }

    this.evictStale();
  }

  private matchDecoration(uri: string | undefined): void {
    const now = Date.now();

    // Match against pending saves
    for (const chain of this.pendingSaves) {
      if (!chain.decorated && chain.uri === uri) {
        chain.decorated = true;
        this.reportLatency(
          'saveToDecoration',
          now - chain.startedAt,
          'decoration.provideFileDecoration',
          undefined,
          uri,
        );
        break;
      }
    }

    // Match against pending refreshes (no URI match needed)
    for (const chain of this.pendingRefreshes) {
      if (!chain.decorated) {
        chain.decorated = true;
        this.reportLatency(
          'refreshToDecoration',
          now - chain.startedAt,
          'decoration.provideFileDecoration',
          chain.provider,
        );
        break;
      }
    }
  }

  private reportLatency(
    metric: string,
    valueMs: number,
    sourceEvent: string,
    provider?: string,
    uri?: string,
  ): void {
    this.reporter.report({
      type: 'perf.latency',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'PerformanceMonitor',
      metric,
      valueMs,
      sourceEvent,
      provider,
      uri,
    } as any);
  }

  private evictStale(): void {
    const now = Date.now();
    let i: number;

    i = 0;
    while (i < this.pendingSaves.length) {
      if (now - this.pendingSaves[i].startedAt > SAVE_WINDOW_MS) {
        this.pendingSaves.splice(i, 1);
      } else {
        i++;
      }
    }

    i = 0;
    while (i < this.pendingRefreshes.length) {
      if (now - this.pendingRefreshes[i].startedAt > REFRESH_WINDOW_MS) {
        this.pendingRefreshes.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription?.dispose();
    this.pendingSaves.length = 0;
    this.pendingRefreshes.length = 0;
  }
}

/** Create a PerformanceMonitor attached to the given reporter */
export function createPerformanceMonitor(
  reporter: TelemetryReporter
): PerformanceMonitor {
  return new PerformanceMonitor(reporter);
}