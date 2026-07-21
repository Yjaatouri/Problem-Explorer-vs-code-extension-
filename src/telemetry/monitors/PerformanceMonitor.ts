import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

export interface PerformanceLatencyEventData {
  readonly type: 'perf.latency';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'PerformanceMonitor';
  readonly metric: string;
  readonly valueMs: number;
  readonly sourceEvent: string;
  readonly provider?: string;
  readonly uri?: string;
}

export interface PerformanceSnapshotEventData {
  readonly type: 'perf.snapshot';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'PerformanceMonitor';
  readonly statistics: PerformanceStatistics;
}

export interface PerformanceHotspotEventData {
  readonly type: 'perf.hotspot';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'PerformanceMonitor';
  readonly metric: string;
  readonly valueMs: number;
  readonly thresholdMs: number;
  readonly provider?: string;
  readonly uri?: string;
  readonly detail: string;
}

export interface PerformanceResourceEventData {
  readonly type: 'perf.resource';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'PerformanceMonitor';
  readonly memoryMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly activePipelines: number;
  readonly activeScans: number;
  readonly queuedWrites: number;
  readonly snapshotCount: number;
}

export interface PerformanceProviderEventData {
  readonly type: 'perf.provider';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'PerformanceMonitor';
  readonly provider: string;
  readonly scanDurationMs: number;
  readonly refreshDurationMs: number;
  readonly queueWaitMs: number;
  readonly failures: number;
  readonly cancellations: number;
  readonly timeouts: number;
}

export type PerformanceMonitorEvent =
  | PerformanceLatencyEventData
  | PerformanceSnapshotEventData
  | PerformanceHotspotEventData
  | PerformanceResourceEventData
  | PerformanceProviderEventData;

/* ------------------------------------------------------------------ */
/*  Rolling History                                                    */
/* ------------------------------------------------------------------ */

export class RollingSample<T> {
  private readonly samples: T[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(value: T): void {
    this.samples.push(value);
    if (this.samples.length > this.maxSize) {
      this.samples.shift();
    }
  }

  get length(): number { return this.samples.length; }
  get capacity(): number { return this.maxSize; }

  values(): readonly T[] {
    return this.samples;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Metric History                                                     */
/* ------------------------------------------------------------------ */

export class MetricHistory {
  private readonly values: RollingSample<number>;

  constructor(maxSize: number) {
    this.values = new RollingSample<number>(maxSize);
  }

  record(valueMs: number): void {
    this.values.push(valueMs);
  }

  get count(): number { return this.values.length; }

  average(): number {
    const v = this.values.values();
    if (v.length === 0) return 0;
    let sum = 0;
    for (const x of v) sum += x;
    return sum / v.length;
  }

  min(): number {
    const v = this.values.values();
    if (v.length === 0) return 0;
    let m = v[0];
    for (const x of v) if (x < m) m = x;
    return m;
  }

  max(): number {
    const v = this.values.values();
    if (v.length === 0) return 0;
    let m = v[0];
    for (const x of v) if (x > m) m = x;
    return m;
  }

  percentile(p: number): number {
    const sorted = [...this.values.values()].sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  clear(): void {
    this.values.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  Performance Statistics                                             */
/* ------------------------------------------------------------------ */

export interface LatencyStats {
  readonly averageMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly sampleCount: number;
}

export interface ProviderStats {
  readonly provider: string;
  readonly scanAverageMs: number;
  readonly scanCount: number;
  readonly refreshAverageMs: number;
  readonly refreshCount: number;
  readonly failures: number;
  readonly cancellations: number;
  readonly timeouts: number;
  readonly queueWaitAverageMs: number;
}

export interface ResourceStats {
  readonly memoryMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly activePipelines: number;
  readonly activeScans: number;
  readonly queuedWrites: number;
  readonly snapshotCount: number;
}

export interface HealthScore {
  readonly score: number;
  readonly level: 'healthy' | 'fair' | 'degraded' | 'critical';
  readonly reasons: string[];
}

export interface PerformanceStatistics {
  readonly latency: Record<string, LatencyStats>;
  readonly provider: ProviderStats[];
  readonly resources: ResourceStats;
  readonly throughput: number;
  readonly slowestOperation: { metric: string; valueMs: number; timestamp: number };
  readonly bottlenecks: string[];
  readonly health: HealthScore;
  readonly totalSamples: number;
  readonly trackedSince: number;
}

/* ------------------------------------------------------------------ */
/*  Snapshot                                                           */
/* ------------------------------------------------------------------ */

export interface PerformanceSnapshot {
  readonly statistics: PerformanceStatistics;
  readonly activeMeasurements: number;
  readonly hotspotCount: number;
  readonly providerCount: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_HISTORY_SIZE = 1000;
const HOTSPOT_SAVE_THRESHOLD_MS = 5000;
const HOTSPOT_PROVIDER_THRESHOLD_MS = 3000;
const HOTSPOT_STAGE_THRESHOLD_MS = 2000;
const RESOURCE_INTERVAL_MS = 30000;
const HEALTH_QUEUE_THRESHOLD = 100;
const HEALTH_LATENCY_THRESHOLD_MS = 10000;
const HEALTH_FAILURE_RATE = 0.1;
const MAX_BOTTLENECKS = 10;

/* ------------------------------------------------------------------ */
/*  PerformanceMonitor                                                 */
/* ------------------------------------------------------------------ */

export class PerformanceMonitor {
  private readonly subscription: TelemetrySubscription;
  private readonly resourceTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  /* Histories */
  private readonly histories = new Map<string, MetricHistory>();

  /* Provider tracking */
  private readonly providerStats = new Map<string, {
    scanDurationSum: number; scanCount: number;
    refreshDurationSum: number; refreshCount: number;
    failures: number; cancellations: number; timeouts: number;
    queueWaitSum: number; queueWaitCount: number;
  }>();

  /* Resource tracking */
  private lastResourceStats: ResourceStats = {
    memoryMb: 0, heapUsedMb: 0, heapTotalMb: 0,
    activePipelines: 0, activeScans: 0, queuedWrites: 0, snapshotCount: 0,
  };

  /* Bottleneck tracking */
  private readonly bottleneckCounts = new Map<string, number>();

  /* Throughput */
  private sampleCount = 0;
  private trackedSince = Date.now();
  private totalLatencyMs = 0;

  /* Slowest operation */
  private slowestMetric = '';
  private slowestValueMs = 0;
  private slowestTimestamp = 0;

  /* Latency chain tracking */
  private readonly pendingSaveToProvider: { uri: string; startedAt: number }[] = [];
  private readonly pendingProviderToStore: { uri: string; startedAt: number }[] = [];
  private readonly pendingStoreToFolder: { uri: string; startedAt: number }[] = [];
  private readonly pendingFolderToDecoration: { uri: string; startedAt: number }[] = [];

  constructor(private readonly reporter: TelemetryReporter) {
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('perf.') || event.type.startsWith('pipeline.')) return;
      try { this.processEvent(event); } catch { /* swallow */ }
    });

    this.resourceTimer = setInterval(() => {
      this.captureResourceUsage();
    }, RESOURCE_INTERVAL_MS);
  }

  private getOrCreateHistory(metric: string): MetricHistory {
    let h = this.histories.get(metric);
    if (!h) {
      h = new MetricHistory(DEFAULT_HISTORY_SIZE);
      this.histories.set(metric, h);
    }
    return h;
  }

  private getOrCreateProviderStats(provider: string): NonNullable<ReturnType<PerformanceMonitor['providerStats']['get']>> {
    let s = this.providerStats.get(provider);
    if (!s) {
      s = { scanDurationSum: 0, scanCount: 0, refreshDurationSum: 0, refreshCount: 0, failures: 0, cancellations: 0, timeouts: 0, queueWaitSum: 0, queueWaitCount: 0 };
      this.providerStats.set(provider, s);
    }
    return s;
  }

  /* ------------------------------------------------------------------ */
  /*  Event Processing                                                   */
  /* ------------------------------------------------------------------ */

  private processEvent(event: TelemetryEvent): void {
    const data = event as any;

    switch (event.type) {
      /* ── Pipeline seeds for latency chains ── */
      case 'autoscan.fileSaved': {
        this.pendingSaveToProvider.push({ uri: data.uri as string, startedAt: Date.now() });
        break;
      }

      case 'provider.scan': {
        if (data.phase === 'begin' && data.uri) {
          this.matchChain(this.pendingSaveToProvider, data.uri, 'saveToProvider', data.provider);
          this.pendingProviderToStore.push({ uri: data.uri as string, startedAt: Date.now() });
        }
        if ((data.phase === 'end' || data.phase === 'error' || data.phase === 'cancelled') && typeof data.executionTimeMs === 'number') {
          this.recordLatency('providerScan', data.executionTimeMs, data.provider);
          this.recordProviderScan(data.provider, data.executionTimeMs);
          if (data.phase === 'error') this.recordProviderFailure(data.provider);
          if (data.phase === 'cancelled') this.recordProviderCancellation(data.provider);
        }
        break;
      }

      case 'store.set':
      case 'store.delete': {
        if (typeof data.executionTimeMs === 'number') {
          this.recordLatency('storeUpdate', data.executionTimeMs, data.provider);
          this.matchChain(this.pendingProviderToStore, data.uri, 'providerToStore', data.provider);
          this.pendingStoreToFolder.push({ uri: data.uri as string, startedAt: Date.now() });
        }
        break;
      }

      case 'folder.updateAncestors': {
        if (typeof data.executionTimeMs === 'number') {
          this.recordLatency('folderUpdate', data.executionTimeMs, undefined, data.uri);
          this.matchChain(this.pendingStoreToFolder, data.uri, 'storeToFolder', undefined);
          this.pendingFolderToDecoration.push({ uri: data.uri as string, startedAt: Date.now() });
        }
        break;
      }

      case 'folder.rebuildAll': {
        if (typeof data.executionTimeMs === 'number') {
          this.recordLatency('folderRebuildAll', data.executionTimeMs);
        }
        break;
      }

      case 'decoration.fire': {
        if (typeof data.executionTimeMs === 'number') {
          this.recordLatency('decorationFire', data.executionTimeMs);
        }
        this.matchChain(this.pendingFolderToDecoration, undefined, 'folderToDecoration', undefined);
        break;
      }

      case 'decoration.provide': {
        if (typeof data.executionTimeMs === 'number') {
          this.recordLatency('decorationProvide', data.executionTimeMs, undefined, data.uri);
        }
        break;
      }

      case 'timer.executed': {
        if (typeof data.callbackDuration === 'number' && data.callbackDuration > 50) {
          this.recordLatency('timerCallback', data.callbackDuration);
        }
        break;
      }

      case 'autoscan.flush': {
        if (typeof data.executionTimeMs === 'number') {
          this.recordLatency('autoScanFlush', data.executionTimeMs);
        }
        break;
      }

      case 'autoscan.debounce': {
        if (typeof data.debounceMs === 'number') {
          this.recordLatency('autoScanDebounce', data.debounceMs);
        }
        break;
      }

      default: {
        if (data.executionTimeMs && typeof data.executionTimeMs === 'number') {
          this.recordLatency(`event.${event.type}`, data.executionTimeMs);
        }
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Latency Chain Matching                                             */
  /* ------------------------------------------------------------------ */

  private matchChain(pending: { uri: string; startedAt: number }[], uri: string | undefined, metric: string, provider?: string): void {
    const now = Date.now();
    for (let i = 0; i < pending.length; i++) {
      if (uri === undefined || pending[i].uri === uri) {
        const chain = pending.splice(i, 1)[0];
        this.recordLatency(metric, now - chain.startedAt, provider);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Recording                                                          */
  /* ------------------------------------------------------------------ */

  private recordLatency(metric: string, valueMs: number, provider?: string, uri?: string): void {
    if (valueMs < 0) return;
    this.sampleCount++;
    this.totalLatencyMs += valueMs;

    const history = this.getOrCreateHistory(metric);
    history.record(valueMs);

    if (valueMs > this.slowestValueMs) {
      this.slowestValueMs = valueMs;
      this.slowestMetric = metric;
      this.slowestTimestamp = Date.now();
    }

    this.reporter.report({
      type: 'perf.latency',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'PerformanceMonitor',
      metric,
      valueMs,
      sourceEvent: metric,
      provider,
      uri,
    } as any);

    /* Hotspot detection */
    this.detectHotspot(metric, valueMs, provider, uri);
  }

  /* ------------------------------------------------------------------ */
  /*  Provider Tracking                                                  */
  /* ------------------------------------------------------------------ */

  private recordProviderScan(provider: string, durationMs: number): void {
    const s = this.getOrCreateProviderStats(provider);
    s.scanDurationSum += durationMs;
    s.scanCount++;
  }

  private recordProviderFailure(provider: string): void {
    const s = this.getOrCreateProviderStats(provider);
    s.failures++;
  }

  private recordProviderCancellation(provider: string): void {
    const s = this.getOrCreateProviderStats(provider);
    s.cancellations++;
  }

  /* ------------------------------------------------------------------ */
  /*  Hotspot Detection                                                  */
  /* ------------------------------------------------------------------ */

  private detectHotspot(metric: string, valueMs: number, provider?: string, uri?: string): void {
    let thresholdMs = HOTSPOT_STAGE_THRESHOLD_MS;
    if (metric.startsWith('save') || metric.startsWith('provider')) thresholdMs = HOTSPOT_SAVE_THRESHOLD_MS;
    if (metric.startsWith('provider')) thresholdMs = HOTSPOT_PROVIDER_THRESHOLD_MS;

    if (valueMs > thresholdMs) {
      const key = provider ? `${metric}:${provider}` : metric;
      this.bottleneckCounts.set(key, (this.bottleneckCounts.get(key) ?? 0) + 1);

      const detail = provider
        ? `${metric} took ${valueMs.toFixed(0)}ms (threshold ${thresholdMs}ms) for provider ${provider}`
        : `${metric} took ${valueMs.toFixed(0)}ms (threshold ${thresholdMs}ms)`;

      this.reporter.report({
        type: 'perf.hotspot',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'PerformanceMonitor',
        metric,
        valueMs,
        thresholdMs,
        provider,
        uri,
        detail,
      } as any);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Resource Usage                                                     */
  /* ------------------------------------------------------------------ */

  private captureResourceUsage(): void {
    const mem = process.memoryUsage();
    const memoryMb = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
    const heapUsedMb = Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10;
    const heapTotalMb = Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10;

    this.lastResourceStats = {
      memoryMb,
      heapUsedMb,
      heapTotalMb,
      activePipelines: 0,
      activeScans: 0,
      queuedWrites: 0,
      snapshotCount: 0,
    };

    this.reporter.report({
      type: 'perf.resource',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'PerformanceMonitor',
      memoryMb,
      heapUsedMb,
      heapTotalMb,
      activePipelines: 0,
      activeScans: 0,
      queuedWrites: 0,
      snapshotCount: 0,
    } as any);
  }

  updateResourceCounts(activePipelines: number, activeScans: number, queuedWrites: number, snapshotCount: number): void {
    this.lastResourceStats = {
      ...this.lastResourceStats,
      activePipelines,
      activeScans,
      queuedWrites,
      snapshotCount,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Statistics API                                                     */
  /* ------------------------------------------------------------------ */

  getStatistics(): PerformanceStatistics {
    const latency: Record<string, LatencyStats> = {};
    for (const [metric, history] of this.histories) {
      latency[metric] = {
        averageMs: Math.round(history.average() * 10) / 10,
        minMs: Math.round(history.min() * 10) / 10,
        maxMs: Math.round(history.max() * 10) / 10,
        p50Ms: Math.round(history.percentile(50) * 10) / 10,
        p95Ms: Math.round(history.percentile(95) * 10) / 10,
        p99Ms: Math.round(history.percentile(99) * 10) / 10,
        sampleCount: history.count,
      };
    }

    const provider: ProviderStats[] = [];
    for (const [name, s] of this.providerStats) {
      provider.push({
        provider: name,
        scanAverageMs: s.scanCount > 0 ? Math.round(s.scanDurationSum / s.scanCount) : 0,
        scanCount: s.scanCount,
        refreshAverageMs: s.refreshCount > 0 ? Math.round(s.refreshDurationSum / s.refreshCount) : 0,
        refreshCount: s.refreshCount,
        failures: s.failures,
        cancellations: s.cancellations,
        timeouts: s.timeouts,
        queueWaitAverageMs: s.queueWaitCount > 0 ? Math.round(s.queueWaitSum / s.queueWaitCount) : 0,
      });
    }

    const health = this.computeHealthScore();
    const bottlenecks = this.computeBottlenecks();

    const elapsedSec = (Date.now() - this.trackedSince) / 1000;
    const throughput = elapsedSec > 0 ? Math.round(this.sampleCount / elapsedSec) : 0;

    return {
      latency,
      provider: provider.sort((a, b) => b.scanAverageMs - a.scanAverageMs),
      resources: { ...this.lastResourceStats },
      throughput,
      slowestOperation: { metric: this.slowestMetric, valueMs: this.slowestValueMs, timestamp: this.slowestTimestamp },
      bottlenecks,
      health,
      totalSamples: this.sampleCount,
      trackedSince: this.trackedSince,
    };
  }

  captureSnapshot(): PerformanceSnapshot {
    const stats = this.getStatistics();
    return {
      statistics: stats,
      activeMeasurements: this.pendingSaveToProvider.length + this.pendingProviderToStore.length + this.pendingStoreToFolder.length + this.pendingFolderToDecoration.length,
      hotspotCount: this.bottleneckCounts.size,
      providerCount: this.providerStats.size,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Health & Bottlenecks                                               */
  /* ------------------------------------------------------------------ */

  private computeHealthScore(): HealthScore {
    const reasons: string[] = [];
    let deductions = 0;

    /* Queue health */
    if (this.pendingSaveToProvider.length > HEALTH_QUEUE_THRESHOLD) {
      deductions += 20;
      reasons.push(`Save queue: ${this.pendingSaveToProvider.length} pending`);
    }

    /* Latency health */
    for (const [metric, history] of this.histories) {
      const p95 = history.percentile(95);
      if (p95 > HEALTH_LATENCY_THRESHOLD_MS) {
        deductions += 15;
        reasons.push(`${metric} p95=${p95.toFixed(0)}ms exceeds ${HEALTH_LATENCY_THRESHOLD_MS}ms`);
        break;
      }
    }

    /* Provider failure rate */
    for (const [, s] of this.providerStats) {
      const total = s.scanCount + s.failures + s.cancellations;
      if (total > 0 && (s.failures + s.cancellations) / total > HEALTH_FAILURE_RATE) {
        deductions += 10;
        reasons.push(`Provider failure rate > ${HEALTH_FAILURE_RATE * 100}%`);
        break;
      }
    }

    /* Bottleneck count */
    if (this.bottleneckCounts.size > 5) {
      deductions += Math.min(20, this.bottleneckCounts.size * 2);
      reasons.push(`${this.bottleneckCounts.size} distinct bottlenecks`);
    }

    const score = Math.max(0, 100 - deductions);
    let level: HealthScore['level'] = 'healthy';
    if (score < 30) level = 'critical';
    else if (score < 60) level = 'degraded';
    else if (score < 80) level = 'fair';

    return { score, level, reasons };
  }

  private computeBottlenecks(): string[] {
    const sorted = [...this.bottleneckCounts.entries()]
      .sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, MAX_BOTTLENECKS).map(([key, count]) => `${key} (${count}x)`);
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    clearInterval(this.resourceTimer);
    this.histories.clear();
    this.providerStats.clear();
    this.bottleneckCounts.clear();
    this.pendingSaveToProvider.length = 0;
    this.pendingProviderToStore.length = 0;
    this.pendingStoreToFolder.length = 0;
    this.pendingFolderToDecoration.length = 0;
  }
}

/** Create a PerformanceMonitor attached to the given reporter */
export function createPerformanceMonitor(
  reporter: TelemetryReporter
): PerformanceMonitor {
  return new PerformanceMonitor(reporter);
}
