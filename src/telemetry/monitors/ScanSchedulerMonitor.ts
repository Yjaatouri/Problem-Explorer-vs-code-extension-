import { Disposable } from 'vscode';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TraceId, generateTraceId } from '../../telemetry/TelemetryConfig';
import type { ScanJob } from '../../scanner/ScanJob';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

/** Job submitted to scheduler */
export interface ScanSchedulerJobSubmittedEvent {
  readonly type: 'scheduler.jobSubmitted';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly jobId: string;
  readonly providerNames: readonly string[];
  readonly reason: string;
  readonly eventSource: string;
  readonly priority: number;
  readonly uriCount: number;
}

/** Job merged (deduplicated) */
export interface ScanSchedulerJobMergedEvent {
  readonly type: 'scheduler.jobMerged';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly newJobId: string;
  readonly existingJobId: string;
  readonly providerNames: readonly string[];
  readonly mergedUriCount: number;
}

/** Job cancelled (superseded by higher priority) */
export interface ScanSchedulerJobCancelledEvent {
  readonly type: 'scheduler.jobCancelled';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly jobId: string;
  readonly reason: string;
  readonly cancelledAtStage: 'pending' | 'ready' | 'inflight';
}

/** Job started execution */
export interface ScanSchedulerJobStartedEvent {
  readonly type: 'scheduler.jobStarted';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly jobId: string;
  readonly providerNames: readonly string[];
  readonly priority: number;
  readonly waitTimeMs: number;
}

/** Job completed */
export interface ScanSchedulerJobCompletedEvent {
  readonly type: 'scheduler.jobCompleted';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly jobId: string;
  readonly providerNames: readonly string[];
  readonly executionTimeMs: number;
  readonly success: boolean;
  readonly error?: string;
}

/** Queue state snapshot */
export interface ScanSchedulerQueueEvent {
  readonly type: 'scheduler.queue';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly pendingCount: number;
  readonly readyCount: number;
  readonly inflightCount: number;
  readonly action: 'added' | 'removed' | 'merged' | 'cancelled';
}

/** Reconciliation run */
export interface ScanSchedulerReconcileEvent {
  readonly type: 'scheduler.reconcile';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'ScanSchedulerMonitor';
  readonly submitted: boolean;
  readonly skipReason?: string;
}

/** Union of all scheduler monitor events */
export type ScanSchedulerTelemetryEvent =
  | ScanSchedulerJobSubmittedEvent
  | ScanSchedulerJobMergedEvent
  | ScanSchedulerJobCancelledEvent
  | ScanSchedulerJobStartedEvent
  | ScanSchedulerJobCompletedEvent
  | ScanSchedulerQueueEvent
  | ScanSchedulerReconcileEvent;

/* ------------------------------------------------------------------ */
/*  Statistics & snapshot interfaces                                   */
/* ------------------------------------------------------------------ */

export interface ScanSchedulerStatistics {
  /** Total jobs submitted to scheduler */
  totalSubmitted: number;
  /** Total jobs that were merged (deduplicated) */
  totalMerged: number;
  /** Total jobs cancelled (superseded) */
  totalCancelled: number;
  /** Total jobs started execution */
  totalStarted: number;
  /** Total jobs completed successfully */
  totalCompleted: number;
  /** Total jobs failed */
  totalFailed: number;
  
  /** Average time from submit to start (queue wait) */
  averageWaitTimeMs: number;
  /** Average execution time */
  averageExecutionTimeMs: number;
  /** End-to-end latency (submit → decoration update) */
  averageEndToEndMs: number;
  
  /** Peak queue sizes */
  peakPendingCount: number;
  peakReadyCount: number;
  peakInFlightCount: number;
  
  /** Provider-specific execution times */
  providerExecutionTimes: Record<string, {
    count: number;
    totalMs: number;
    averageMs: number;
    maxMs: number;
  }>;
  
  /** Current queue state */
  currentPendingCount: number;
  currentReadyCount: number;
  currentInFlightCount: number;
  
  /** Reconciliation stats */
  reconcileRuns: number;
  lastReconcileTimestamp: number;
}

export interface ScanSchedulerSnapshot {
  statistics: ScanSchedulerStatistics;
  /** Jobs currently in each stage */
  queuedJobs: Array<{ jobId: string; provider: string; priority: number; ageMs: number }>;
  executingJobs: Array<{ jobId: string; provider: string; elapsedMs: number }>;
}

/* ------------------------------------------------------------------ */
/*  Internal tracking state                                            */
/* ------------------------------------------------------------------ */

interface JobTracking {
  jobId: string;
  providerNames: readonly string[];
  priority: number;
  submittedAt: number;
  stage: 'pending' | 'ready' | 'inflight' | 'completed' | 'cancelled';
  startedAt?: number;
  completedAt?: number;
  executionTimeMs?: number;
  uriCount: number;
  waitTimeMs?: number;
}

interface ProviderExecutionStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface LatencyChainEntry {
  jobId: string;
  uri: string;
  submittedAt: number;
  providerStartedAt?: number;
  providerCompletedAt?: number;
  storeUpdatedAt?: number;
  folderUpdatedAt?: number;
  decorationFiredAt?: number;
}

/* ------------------------------------------------------------------ */
/*  ScanSchedulerMonitor                                               */
/* ------------------------------------------------------------------ */

export class ScanSchedulerMonitor implements Disposable {
  private readonly jobs = new Map<string, JobTracking>();
  private readonly providerStats = new Map<string, ProviderExecutionStats>();
  private readonly latencyChains = new Map<string, LatencyChainEntry>();
  
  private readonly disposables: Disposable[] = [];
  private disposed = false;

  private totalSubmitted = 0;
  private totalMerged = 0;
  private totalCancelled = 0;
  private totalStarted = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  
  private totalWaitTimeMs = 0;
  private totalExecutionTimeMs = 0;
  private totalEndToEndTimeMs = 0;
  private completedCount = 0;
  
  private peakPendingCount = 0;
  private peakReadyCount = 0;
  private peakInFlightCount = 0;
  
  private reconcileRuns = 0;
  private lastReconcileTimestamp = 0;

  constructor(
    private readonly reporter: TelemetryReporter,
    readonly getQueueSizes: () => { pending: number; ready: number; inflight: number }
  ) {
    this.subscribeToTelemetry();
    this.startPeriodicSnapshot();
  }

  /* ---------------------------------------------------------------- */
  /*  Scheduler callback interface (called directly by ScanScheduler)  */
  /* ---------------------------------------------------------------- */

  onJobSubmitted(job: ScanJob, dedupKey: string): void {
    this.totalSubmitted++;
    const now = Date.now();
    const jobTrack: JobTracking = {
      jobId: job.jobId,
      providerNames: [job.provider],
      priority: job.priority,
      submittedAt: now,
      stage: 'pending',
      uriCount: job.uris.length,
    };
    this.jobs.set(job.jobId, jobTrack);
    this.updatePeaks();
    this.reporter.report({
      type: 'scheduler.jobSubmitted',
      traceId: generateTraceId(),
      timestamp: now,
      source: 'ScanSchedulerMonitor',
      jobId: job.jobId,
      dedupKey,
      providerName: job.provider,
      priority: job.priority,
      uriCount: job.uris.length,
    } as any);
  }

  onJobMerged(existingJobId: string, newJobId: string, dedupKey: string): void {
    this.totalMerged++;
    this.reporter.report({
      type: 'scheduler.jobMerged',
      traceId: generateTraceId(),
      timestamp: Date.now(),
      source: 'ScanSchedulerMonitor',
      newJobId,
      existingJobId,
      dedupKey,
    } as any);
  }

  onJobFlushed(job: ScanJob, queueLength: number): void {
    this.reporter.report({
      type: 'scheduler.queue',
      traceId: generateTraceId(),
      timestamp: Date.now(),
      source: 'ScanSchedulerMonitor',
      jobId: job.jobId,
      queueLength,
    } as any);
  }

  onJobStarted(job: ScanJob): void {
    this.totalStarted++;
    const now = Date.now();
    const jobTrack = this.jobs.get(job.jobId);
    if (jobTrack) {
      jobTrack.stage = 'inflight';
      jobTrack.startedAt = now;
      jobTrack.waitTimeMs = now - jobTrack.submittedAt;
      this.totalWaitTimeMs += jobTrack.waitTimeMs;
    }
    this.updatePeaks();
    this.reporter.report({
      type: 'scheduler.jobStarted',
      traceId: generateTraceId(),
      timestamp: now,
      source: 'ScanSchedulerMonitor',
      jobId: job.jobId,
      providerName: job.provider,
      waitTimeMs: job.jobId ? (this.jobs.get(job.jobId)?.waitTimeMs ?? 0) : 0,
    } as any);
  }

  onJobCompleted(job: ScanJob, executionTimeMs: number): void {
    const now = Date.now();
    const jobTrack = this.jobs.get(job.jobId);
    if (jobTrack) {
      jobTrack.stage = 'completed';
      jobTrack.completedAt = now;
      jobTrack.executionTimeMs = executionTimeMs;
      if (jobTrack.startedAt) {
        this.totalExecutionTimeMs += executionTimeMs;
      }
      this.totalCompleted++;
      this.completedCount++;
    }
    this.updatePeaks();
    this.reporter.report({
      type: 'scheduler.jobCompleted',
      traceId: generateTraceId(),
      timestamp: now,
      source: 'ScanSchedulerMonitor',
      jobId: job.jobId,
      providerName: job.provider,
      executionTimeMs,
      success: true,
    } as any);
  }

  onJobCancelled(job: ScanJob, reason: string): void {
    this.totalCancelled++;
    const now = Date.now();
    const jobTrack = this.jobs.get(job.jobId);
    if (jobTrack) {
      jobTrack.stage = 'cancelled';
      jobTrack.completedAt = now;
    }
    this.updatePeaks();
    this.reporter.report({
      type: 'scheduler.jobCancelled',
      traceId: generateTraceId(),
      timestamp: now,
      source: 'ScanSchedulerMonitor',
      jobId: job.jobId,
      reason,
    } as any);
  }

  onJobFailed(job: ScanJob, error: Error): void {
    this.totalFailed++;
    const now = Date.now();
    const jobTrack = this.jobs.get(job.jobId);
    if (jobTrack) {
      jobTrack.stage = 'completed';
      jobTrack.completedAt = now;
    }
    this.updatePeaks();
    this.reporter.report({
      type: 'scheduler.jobCompleted',
      traceId: generateTraceId(),
      timestamp: now,
      source: 'ScanSchedulerMonitor',
      jobId: job.jobId,
      providerName: job.provider,
      executionTimeMs: this.jobs.get(job.jobId)?.executionTimeMs ?? 0,
      success: false,
      errorMessage: error.message,
    } as any);
  }

  onReconcileRun(): void {
    this.reconcileRuns++;
    this.lastReconcileTimestamp = Date.now();
    this.reporter.report({
      type: 'scheduler.reconcile',
      traceId: generateTraceId(),
      timestamp: this.lastReconcileTimestamp,
      source: 'ScanSchedulerMonitor',
      submitted: true,
    } as any);
  }

  private subscribeToTelemetry(): void {
    this.disposables.push(
      this.reporter.subscribeAll((event: any) => {
        if (this.disposed) return;
        try { this.processEvent(event); } catch { /* swallow */ }
      })
    );
  }

  private processEvent(event: any): void {
    // (R2) NOTE: `scheduler.*` events are emitted by this monitor's own direct
    // callbacks (onJobSubmitted/onJobMerged/onJobCancelled/onJobStarted/
    // onJobCompleted/onJobFlushed/onReconcileRun), which already mutate the
    // counters and the `jobs` map. Re‑processing them here would double‑count
    // every statistic. The subscribeAll stream is therefore used ONLY for
    // cross‑monitor latency‑chain events from *other* monitors
    // (autoscan.fileSaved, provider.scan, store.set, folder.updateAncestors,
    // decoration.fire).
    switch (event.type) {
      /* Latency chain events from existing monitors */
      case 'autoscan.fileSaved': {
        this.startLatencyChain(event.jobId, event.uri);
        break;
      }
      case 'provider.scan': {
        if (event.phase === 'begin' && event.uri) {
          this.markProviderStart(event.jobId, event.uri, event.provider);
        }
        break;
      }
      case 'store.set': {
        if (event.uri) {
          this.markStoreUpdate(event.jobId, event.uri);
        }
        break;
      }
      case 'folder.updateAncestors': {
        if (event.uri) {
          this.markFolderUpdate(event.jobId, event.uri);
        }
        break;
      }
      case 'decoration.fire': {
        this.completeLatencyChain(event.jobId);
        break;
      }
    }
  }

  private updatePeaks(): void {
    const sizes = this.getQueueSizes();
    this.peakPendingCount = Math.max(this.peakPendingCount, sizes.pending);
    this.peakReadyCount = Math.max(this.peakReadyCount, sizes.ready);
    this.peakInFlightCount = Math.max(this.peakInFlightCount, sizes.inflight);
  }

  private startLatencyChain(jobId: string, uri: string): void {
    this.latencyChains.set(jobId + ':' + uri, {
      jobId,
      uri,
      submittedAt: Date.now(),
    });
  }

  private markProviderStart(jobId: string, uri: string, provider: string): void {
    const key = jobId + ':' + uri;
    const chain = this.latencyChains.get(key);
    if (chain) {
      chain.providerStartedAt = Date.now();
    }
    /* Record provider execution stats */
    let stats = this.providerStats.get(provider);
    if (!stats) {
      stats = { count: 0, totalMs: 0, maxMs: 0 };
      this.providerStats.set(provider, stats);
    }
  }

  private markStoreUpdate(jobId: string, uri: string): void {
    const key = jobId + ':' + uri;
    const chain = this.latencyChains.get(key);
    if (chain && !chain.storeUpdatedAt) {
      chain.storeUpdatedAt = Date.now();
    }
  }

  private markFolderUpdate(jobId: string, uri: string): void {
    const key = jobId + ':' + uri;
    const chain = this.latencyChains.get(key);
    if (chain && !chain.folderUpdatedAt) {
      chain.folderUpdatedAt = Date.now();
    }
  }

  private completeLatencyChain(jobId: string): void {
    const keysToRemove: string[] = [];
    for (const [key, chain] of this.latencyChains) {
      if (chain.jobId === jobId) {
        chain.decorationFiredAt = Date.now();
        const endToEnd = chain.decorationFiredAt - chain.submittedAt;
        this.totalEndToEndTimeMs += endToEnd;
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.latencyChains.delete(key);
    }
  }

  private startPeriodicSnapshot(): void {
    const interval = setInterval(() => {
      if (this.disposed) return;
      this.emitSnapshot();
    }, 10000);
    this.disposables.push({ dispose: () => clearInterval(interval) });
  }

  private emitSnapshot(): void {
    try {
      this.reporter.report({
        type: 'scheduler.snapshot',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'ScanSchedulerMonitor',
        statistics: this.getStatistics(),
      } as any);
    } catch { /* non-critical */ }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  getStatistics(): ScanSchedulerStatistics {
    const providerExecutionTimes: Record<string, { count: number; totalMs: number; averageMs: number; maxMs: number }> = {};
    for (const [provider, stats] of this.providerStats) {
      providerExecutionTimes[provider] = {
        count: stats.count,
        totalMs: stats.totalMs,
        averageMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
        maxMs: stats.maxMs,
      };
    }

    return {
      totalSubmitted: this.totalSubmitted,
      totalMerged: this.totalMerged,
      totalCancelled: this.totalCancelled,
      totalStarted: this.totalStarted,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      averageWaitTimeMs: this.totalStarted > 0 ? Math.round(this.totalWaitTimeMs / this.totalStarted) : 0,
      averageExecutionTimeMs: this.totalCompleted > 0 ? Math.round(this.totalExecutionTimeMs / this.totalCompleted) : 0,
      averageEndToEndMs: this.completedCount > 0 ? Math.round(this.totalEndToEndTimeMs / this.completedCount) : 0,
      peakPendingCount: this.peakPendingCount,
      peakReadyCount: this.peakReadyCount,
      peakInFlightCount: this.peakInFlightCount,
      providerExecutionTimes,
      currentPendingCount: this.getQueueSizes().pending,
      currentReadyCount: this.getQueueSizes().ready,
      currentInFlightCount: this.getQueueSizes().inflight,
      reconcileRuns: this.reconcileRuns,
      lastReconcileTimestamp: this.lastReconcileTimestamp,
    };
  }

  getSnapshot(): ScanSchedulerSnapshot {
    const queuedJobs: Array<{ jobId: string; provider: string; priority: number; ageMs: number }> = [];
    const executingJobs: Array<{ jobId: string; provider: string; elapsedMs: number }> = [];
    const now = Date.now();

    for (const job of this.jobs.values()) {
      if (job.stage === 'pending' || job.stage === 'ready') {
        queuedJobs.push({
          jobId: job.jobId,
          provider: job.providerNames[0],
          priority: job.priority,
          ageMs: now - job.submittedAt,
        });
      } else if (job.stage === 'inflight' && job.startedAt) {
        executingJobs.push({
          jobId: job.jobId,
          provider: job.providerNames[0],
          elapsedMs: now - job.startedAt,
        });
      }
    }

    return {
      statistics: this.getStatistics(),
      queuedJobs,
      executingJobs,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposables.forEach(d => { try { d.dispose(); } catch {} });
    this.disposables.length = 0;
    this.jobs.clear();
    this.providerStats.clear();
    this.latencyChains.clear();
  }
}

export function createScanSchedulerMonitor(
  reporter: TelemetryReporter,
  getQueueSizes: () => { pending: number; ready: number; inflight: number }
): ScanSchedulerMonitor {
  return new ScanSchedulerMonitor(reporter, getQueueSizes);
}