import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/* ------------------------------------------------------------------ */
/*  Pipeline Identity                                                  */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const PipelineIdBrand: unique symbol;
export type PipelineId = string & { readonly __brand: typeof PipelineIdBrand };


export function generatePipelineId(): PipelineId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` as PipelineId;
}

/* ------------------------------------------------------------------ */
/*  Pipeline Event                                                     */
/* ------------------------------------------------------------------ */

export type StageStatus = 'pending' | 'running' | 'paused' | 'completed' | 'skipped' | 'failed' | 'cancelled' | 'timedOut';

export interface PipelineEvent {
  readonly pipelineId: PipelineId;
  readonly seq: number;
  readonly event: TelemetryEvent;
  readonly stage: string;
  readonly receivedAt: number;
  parentEventSeq?: number;
  readonly childEventSeqs: number[];
  previousEventSeq?: number;
  nextEventSeq?: number;
}

export interface PipelineStage {
  readonly name: string;
  readonly order: number;
  readonly enteredAt: number;
  exitedAt?: number;
  durationMs?: number;
  status: StageStatus;
  readonly eventTypes: string[];
  readonly eventSeqs: number[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Pipeline Execution                                                 */
/* ------------------------------------------------------------------ */

export type PipelineStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'timedOut';

export interface PipelineFailure {
  readonly eventType: string;
  readonly message: string;
  readonly timestamp: number;
  readonly stage: string;
  readonly seq: number;
}

export interface PipelineExecution {
  readonly id: PipelineId;
  readonly uri: string;
  provider?: string;
  trigger?: string;
  readonly startTime: number;
  endTime?: number;
  durationMs?: number;
  status: PipelineStatus;
  readonly stages: Map<string, PipelineStage>;
  readonly stageOrder: string[];
  readonly events: PipelineEvent[];
  readonly failures: PipelineFailure[];
  error?: string;
  readonly createdAt: number;
  lastActivityAt: number;
  pausedDurationMs: number;
  pausedAt?: number;
  pauseCount: number;
}

/* ------------------------------------------------------------------ */
/*  Pipeline Statistics & Snapshot                                     */
/* ------------------------------------------------------------------ */

export interface DurationHistogram {
  readonly buckets: Record<string, number>;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
}

export interface PipelineStatistics {
  totalExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  cancelledExecutions: number;
  timedOutExecutions: number;
  totalEvents: number;
  averagePipelineDurationMs: number;
  peakPipelineDurationMs: number;
  stageDurations: Record<string, { count: number; totalMs: number; peakMs: number; averageMs: number }>;
  concurrentPipelinePeak: number;
  pipelineThroughput: number;
  activeExecutions: number;
  durationHistogram: DurationHistogram;
}

export interface PipelineSnapshot {
  activeExecutions: number;
  totalExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  statistics: PipelineStatistics;
}

/* ------------------------------------------------------------------ */
/*  Telemetry event data interfaces (emitted by this monitor)          */
/* ------------------------------------------------------------------ */

export interface PipelineExecutionStartedEventData {
  readonly type: 'pipeline.execution.started';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly uri: string;
  readonly trigger: string;
  readonly provider?: string;
}

export interface PipelineExecutionCompletedEventData {
  readonly type: 'pipeline.execution.completed';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly uri: string;
  readonly durationMs: number;
  readonly stageCount: number;
  readonly eventCount: number;
  readonly status: PipelineStatus;
  readonly error?: string;
}

export interface PipelineStageEventData {
  readonly type: 'pipeline.stage';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly uri: string;
  readonly stage: string;
  readonly status: StageStatus;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface PipelineExecutionPausedEventData {
  readonly type: 'pipeline.execution.paused';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly uri: string;
  readonly pauseCount: number;
}

export interface PipelineExecutionResumedEventData {
  readonly type: 'pipeline.execution.resumed';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly uri: string;
  readonly totalPausedMs: number;
  readonly pauseCount: number;
}

export interface PipelineExecutionCancelledEventData {
  readonly type: 'pipeline.execution.cancelled';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly uri: string;
  readonly durationMs: number;
  readonly reason?: string;
}

export interface PipelineDuplicateEventData {
  readonly type: 'pipeline.duplicateEvent';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly eventType: string;
  readonly eventTraceId: string;
  readonly originalSeq: number;
  readonly duplicateSeq: number;
}

export interface PipelineCorrelationEventData {
  readonly type: 'pipeline.correlation';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'EventPipelineMonitor';
  readonly pipelineId: PipelineId;
  readonly relatedPipelineId: PipelineId;
  readonly relation: 'parent-child' | 'traceId' | 'causal';
  readonly traceIds: string[];
}

export type CausalChainLink = {
  readonly pipelineId: PipelineId;
  readonly pipelineEvent: PipelineEvent;
  readonly traceId: string;
  readonly parentTraceId?: string;
  readonly depth: number;
};

export type CausalChain = {
  readonly rootTraceId: string;
  readonly links: CausalChainLink[];
  readonly depth: number;
};

export interface PipelineAssertionViolation {
  readonly pipelineId: PipelineId;
  readonly rule: string;
  readonly message: string;
  readonly timestamp: number;
}

export type EventPipelineMonitorEvent =
  | PipelineExecutionStartedEventData
  | PipelineExecutionCompletedEventData
  | PipelineExecutionPausedEventData
  | PipelineExecutionResumedEventData
  | PipelineExecutionCancelledEventData
  | PipelineStageEventData
  | PipelineDuplicateEventData
  | PipelineCorrelationEventData;

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const EXECUTION_TIMEOUT_MS = 60000;
const STALE_CHECK_INTERVAL_MS = 30000;
const MAX_EXECUTIONS = 500;
const MAX_EVENTS_PER_EXECUTION = 1000;
const MAX_EVENTS_TOTAL = 10000;
const MAX_PAUSE_DURATION_MS = 300000;
const MAX_SEEN_KEYS = 5000;
const MAX_DURATION_SAMPLES = 5000;

/** Map event type prefixes to stage names */
function eventTypeToStage(eventType: string): string {
  if (eventType.startsWith('autoscan.')) return 'autoScan';
  if (eventType.startsWith('provider.')) return 'provider';
  if (eventType.startsWith('diagnostics.')) return 'diagnostics';
  if (eventType.startsWith('store.')) return 'store';
  if (eventType.startsWith('folder.')) return 'folder';
  if (eventType.startsWith('decoration.')) return 'decoration';
  return 'unknown';
}

/** Extract URI from any telemetry event */
function extractUri(event: TelemetryEvent): string | undefined {
  const data = event as unknown as Record<string, unknown>;
  if (typeof data.uri === 'string') return data.uri;
  if (typeof data.fileUri === 'string') return data.fileUri;
  if (Array.isArray(data.uris)) {
    const uris = data.uris as string[];
    if (uris.length > 0) return uris[0];
  }
  if (Array.isArray(data.affectedUris)) {
    const uris = data.affectedUris as string[];
    if (uris.length > 0) return uris[0];
  }
  return undefined;
}

/** Extract provider name from any telemetry event */
function extractProvider(event: TelemetryEvent): string | undefined {
  const data = event as unknown as Record<string, unknown>;
  if (typeof data.provider === 'string') return data.provider;
  if (typeof data.providerName === 'string') return data.providerName;
  return undefined;
}

/** Compute percentile from sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Build duration histogram buckets */
function computeHistogram(samples: number[]): DurationHistogram {
  const sorted = [...samples].sort((a, b) => a - b);
  const buckets: Record<string, number> = { '<10ms': 0, '<50ms': 0, '<100ms': 0, '<500ms': 0, '<1s': 0, '<5s': 0, '>=5s': 0 };
  for (const d of sorted) {
    if (d < 10) buckets['<10ms']++;
    else if (d < 50) buckets['<50ms']++;
    else if (d < 100) buckets['<100ms']++;
    else if (d < 500) buckets['<500ms']++;
    else if (d < 1000) buckets['<1s']++;
    else if (d < 5000) buckets['<5s']++;
    else buckets['>=5s']++;
  }
  return {
    buckets,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p99Ms: percentile(sorted, 99),
  };
}

/* ------------------------------------------------------------------ */
/*  EventPipelineMonitor                                               */
/* ------------------------------------------------------------------ */

export class EventPipelineMonitor {
  private seq = 0;
  private readonly executions = new Map<PipelineId, PipelineExecution>();
  private readonly executionsByUri = new Map<string, Set<PipelineId>>();
  private readonly seenKeys = new Map<string, number>();
  private readonly allEvents: PipelineEvent[] = [];
  private readonly traceIdIndex = new Map<string, Set<PipelineEvent>>();
  private readonly pipelineDependencies = new Map<PipelineId, Set<PipelineId>>();
  private readonly subscription: TelemetrySubscription;
  private readonly staleTimer: ReturnType<typeof setInterval>;
  private disposed = false;
  private assertionsEnabled = true;

  /* Statistics */
  private statsStarted = Date.now();
  private peakConcurrent = 0;
  private readonly stageDurationAccumulators: Record<string, { count: number; totalMs: number; peakMs: number }> = {};
  private readonly durationSamples: number[] = [];
  private totalStarted = 0;
  private eventsProcessed = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalCancelled = 0;
  private totalTimedOut = 0;

  private safeReport(event: import('../TelemetryEvent').TelemetryEvent): void {
    try { this.reporter.report(event); } catch { /* non-critical */ }
  }

  constructor(private readonly reporter: TelemetryReporter) {
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('pipeline.')) return;
      try {
        this.processEvent(event);
      } catch {
        /* swallow — prevent crash in telemetry bus */
      }
    });

    this.staleTimer = setInterval(() => {
      this.cleanupStaleExecutions();
    }, STALE_CHECK_INTERVAL_MS);
  }

  /* ------------------------------------------------------------------ */
  /*  Event Processing                                                    */
  /* ------------------------------------------------------------------ */

  private processEvent(event: TelemetryEvent): void {
    const seq = ++this.seq;
    const execution = this.routeToExecution(event);
    if (!execution) return;
    this.detectDuplicate(event, seq);
    this.addEventToExecution(execution, event, seq);
  }

  /** Route an event to the correct pipeline execution, creating one if needed */
  private routeToExecution(event: TelemetryEvent): PipelineExecution | undefined {
    const uri = extractUri(event);
    if (!uri) return undefined;

    /* Look for an active execution for this URI */
    const existingIds = this.executionsByUri.get(uri);
    if (existingIds && existingIds.size > 0) {
      /* Find the most recent active (not paused) execution */
      let best: PipelineExecution | undefined;
      for (const id of existingIds) {
        const ex = this.executions.get(id);
        if (!ex) continue;
        if (ex.status !== 'running') continue;
        if (!best || ex.lastActivityAt > best.lastActivityAt) {
          best = ex;
        }
      }
      if (best) {
        best.lastActivityAt = Date.now();
        return best;
      }
    }

    /* Check if this traceId already belongs to an execution */
    if (event.traceId) {
      const existing = this.traceIdIndex.get(event.traceId);
      if (existing && existing.size > 0) {
        const first = existing.values().next().value;
        if (first) {
          const ex = this.executions.get(first.pipelineId);
          if (ex && ex.status === 'running') {
            ex.lastActivityAt = Date.now();
            return ex;
          }
        }
      }
    }

    /* Check linked by parentTraceId chain to an existing execution */
    if (event.parentTraceId) {
      const parentSet = this.traceIdIndex.get(event.parentTraceId);
      if (parentSet) {
        for (const pe of parentSet) {
          const ex = this.executions.get(pe.pipelineId);
          if (ex && ex.status === 'running') {
            ex.lastActivityAt = Date.now();
            return ex;
          }
        }
      }
    }

    return this.createExecution(event);
  }

  private createExecution(event: TelemetryEvent): PipelineExecution {
    const id = generatePipelineId();
    const uri = extractUri(event)!;
    const provider = extractProvider(event);
    const trigger = event.type;

    const execution: PipelineExecution = {
      id,
      uri,
      provider,
      trigger,
      startTime: Date.now(),
      status: 'running',
      stages: new Map(),
      stageOrder: [],
      events: [],
      failures: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pausedDurationMs: 0,
      pauseCount: 0,
    };

    this.executions.set(id, execution);
    this.totalStarted++;

    let uriSet = this.executionsByUri.get(uri);
    if (!uriSet) {
      uriSet = new Set();
      this.executionsByUri.set(uri, uriSet);
    }
    uriSet.add(id);

    /* Enforce active execution cap */
    if (this.getActiveCount() > MAX_EXECUTIONS) {
      let oldest: PipelineExecution | undefined;
      for (const [, e] of this.executions) {
        if (e.status === 'running' && (!oldest || e.createdAt < oldest.createdAt)) {
          oldest = e;
        }
      }
      if (oldest) {
        this.finalizeExecution(oldest, 'timedOut', 'Active execution cap reached');
      }
    }

    this.emitExecutionStarted(execution, trigger, provider);
    this.updatePeakConcurrent();

    return execution;
  }

  private addEventToExecution(execution: PipelineExecution, event: TelemetryEvent, seq: number): void {
    const stage = eventTypeToStage(event.type);
    const pipelineEvent: PipelineEvent = {
      pipelineId: execution.id,
      seq,
      event,
      stage,
      receivedAt: Date.now(),
      childEventSeqs: [],
    };

    /* Link to previous event in the same execution */
    const lastEvent = execution.events[execution.events.length - 1];
    if (lastEvent) {
      pipelineEvent.previousEventSeq = lastEvent.seq;
      lastEvent.nextEventSeq = pipelineEvent.seq;
    }

    /* Link by traceId parent chain */
    if (event.parentTraceId) {
      for (const pe of execution.events) {
        if (pe.event.traceId === event.parentTraceId) {
          pipelineEvent.parentEventSeq = pe.seq;
          pe.childEventSeqs.push(pipelineEvent.seq);
          break;
        }
      }
    }

    execution.events.push(pipelineEvent);
    this.allEvents.push(pipelineEvent);
    this.eventsProcessed++;

    /* Index by traceId */
    const traceId = event.traceId;
    if (traceId) {
      let eventSet = this.traceIdIndex.get(traceId);
      if (!eventSet) {
        eventSet = new Set();
        this.traceIdIndex.set(traceId, eventSet);
      }
      eventSet.add(pipelineEvent);
    }

    /* Link parent-child pipelines via parentTraceId */
    if (event.parentTraceId) {
      const parentSet = this.traceIdIndex.get(event.parentTraceId);
      if (parentSet) {
        for (const pe of parentSet) {
          if (pe.pipelineId !== execution.id) {
            let deps = this.pipelineDependencies.get(execution.id);
            if (!deps) {
              deps = new Set();
              this.pipelineDependencies.set(execution.id, deps);
            }
            deps.add(pe.pipelineId);
            this.emitCorrelation(execution.id, pe.pipelineId, 'parent-child', [traceId, event.parentTraceId]);
            break;
          }
        }
      }
    }

    /* Enforce event cap per execution — clean up seq pointers */
    if (execution.events.length > MAX_EVENTS_PER_EXECUTION) {
      const removed = execution.events.splice(0, execution.events.length - MAX_EVENTS_PER_EXECUTION);
      const removedSeqs = new Set(removed.map((e) => e.seq));
      for (const re of removed) {
        const tid = re.event.traceId;
        if (tid) this.traceIdIndex.get(tid)?.delete(re);
      }
      for (const remaining of execution.events) {
        if (remaining.previousEventSeq !== undefined && removedSeqs.has(remaining.previousEventSeq)) {
          remaining.previousEventSeq = undefined;
        }
        if (remaining.nextEventSeq !== undefined && removedSeqs.has(remaining.nextEventSeq)) {
          remaining.nextEventSeq = undefined;
        }
        if (remaining.parentEventSeq !== undefined && removedSeqs.has(remaining.parentEventSeq)) {
          remaining.parentEventSeq = undefined;
        }
        for (let i = remaining.childEventSeqs.length - 1; i >= 0; i--) {
          if (removedSeqs.has(remaining.childEventSeqs[i])) {
            remaining.childEventSeqs.splice(i, 1);
          }
        }
      }
    }

    /* Enforce total event cap — clean up traceIdIndex */
    if (this.allEvents.length > MAX_EVENTS_TOTAL) {
      const removed = this.allEvents.splice(0, this.allEvents.length - MAX_EVENTS_TOTAL);
      for (const re of removed) {
        const tid = re.event.traceId;
        if (tid) this.traceIdIndex.get(tid)?.delete(re);
        const ex = this.executions.get(re.pipelineId);
        if (ex) {
          const idx = ex.events.indexOf(re);
          if (idx >= 0) {
            ex.events.splice(idx, 1);
          }
        }
      }
    }

    /* Track stage */
    this.updateStage(execution, stage, event, seq);

    /* Track provider info */
    const provider = extractProvider(event);
    if (provider && !execution.provider) {
      execution.provider = provider;
    }

    execution.lastActivityAt = Date.now();

    /* Capture failures */
    if (this.isStageError(event)) {
      const data = event as unknown as Record<string, unknown>;
      execution.failures.push({
        eventType: event.type,
        message: typeof data.error === 'string' ? data.error : `Phase: ${data.phase ?? 'error'}`,
        timestamp: Date.now(),
        stage,
        seq,
      });
    }

    /* Check for terminal events */
    if (event.type === 'decoration.fire' || event.type === 'autoscan.cancel') {
      this.finalizeExecution(execution, 'completed');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Stage Tracking                                                     */
  /* ------------------------------------------------------------------ */

  private updateStage(execution: PipelineExecution, stageName: string, event: TelemetryEvent, seq: number): void {
    let stage = execution.stages.get(stageName);
    if (!stage) {
      stage = {
        name: stageName,
        order: execution.stageOrder.length,
        enteredAt: Date.now(),
        status: 'running',
        eventTypes: [],
        eventSeqs: [],
      };
      execution.stages.set(stageName, stage);
      execution.stageOrder.push(stageName);
      this.emitStageEvent(execution, stageName, 'running');
    }

    stage.eventSeqs.push(seq);
    if (!stage.eventTypes.includes(event.type)) {
      stage.eventTypes.push(event.type);
    }

    /* Check for stage completion indicators */
    if (this.isStageTerminal(event.type, stageName)) {
      stage.exitedAt = Date.now();
      stage.durationMs = stage.exitedAt - stage.enteredAt;
      stage.status = this.isStageError(event) ? 'failed' : 'completed';
      this.accumulateStageDuration(stageName, stage.durationMs);
      this.emitStageEvent(execution, stageName, stage.status, stage.durationMs, stage.error);
    }
  }

  private isStageTerminal(eventType: string, stage: string): boolean {
    if (stage === 'autoScan' && (eventType === 'autoscan.flush' || eventType === 'autoscan.cancel')) return true;
    if (stage === 'provider' && eventType === 'provider.scan') return true;
    if (stage === 'diagnostics' && eventType === 'diagnostics.storeWrite') return true;
    if (stage === 'store' && eventType === 'store.endBatch') return true;
    if (stage === 'folder' && eventType === 'folder.updateAncestors') return true;
    if (stage === 'decoration' && eventType === 'decoration.fire') return true;
    return false;
  }

  private isStageError(event: TelemetryEvent): boolean {
    const data = event as unknown as Record<string, unknown>;
    if (data.phase === 'cancelled' || data.phase === 'error') return true;
    if (data.error && typeof data.error === 'string') return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Execution Finalization                                             */
  /* ------------------------------------------------------------------ */

  private finalizeExecution(execution: PipelineExecution, status: PipelineStatus, error?: string): void {
    if (execution.status !== 'running' && execution.status !== 'paused') return;
    execution.status = status;
    execution.endTime = Date.now();
    execution.durationMs = Math.max(0, execution.endTime - execution.startTime);
    execution.error = error;

    /* Finalize any still-running stages */
    for (const [, stage] of execution.stages) {
      if (stage.status === 'running') {
        stage.exitedAt = execution.endTime;
        stage.durationMs = stage.exitedAt - stage.enteredAt;
        stage.status = status === 'completed' ? 'completed' : status;
        if (stage.durationMs !== undefined && stage.durationMs >= 0) {
          this.accumulateStageDuration(stage.name, stage.durationMs);
        }
      }
    }

    switch (status) {
      case 'completed': this.totalCompleted++; break;
      case 'failed': this.totalFailed++; break;
      case 'cancelled': this.totalCancelled++; break;
      case 'timedOut': this.totalTimedOut++; break;
    }

    if (execution.durationMs !== undefined) {
      if (this.durationSamples.length >= MAX_DURATION_SAMPLES) {
        this.durationSamples.splice(0, Math.floor(MAX_DURATION_SAMPLES / 4));
      }
      this.durationSamples.push(execution.durationMs);
    }

    this.emitExecutionCompleted(execution);

    /* Remove from URI tracking */
    const key = execution.uri;
    const uriSet = this.executionsByUri.get(key);
    if (uriSet) {
      uriSet.delete(execution.id);
      if (uriSet.size === 0) {
        this.executionsByUri.delete(key);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Duplicate Detection                                                */
  /* ------------------------------------------------------------------ */

  private detectDuplicate(event: TelemetryEvent, seq: number): void {
    const key = `${event.type}:${event.traceId}`;
    const prevSeq = this.seenKeys.get(key);
    if (prevSeq !== undefined) {
      this.safeReport({
        type: 'pipeline.duplicateEvent',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'EventPipelineMonitor',
        eventType: event.type,
        eventTraceId: event.traceId,
        originalSeq: prevSeq,
        duplicateSeq: seq,
      } as any);
    }
    if (this.seenKeys.size >= MAX_SEEN_KEYS) {
      const keysToDelete = [...this.seenKeys.keys()].slice(0, Math.floor(MAX_SEEN_KEYS / 4));
      for (const k of keysToDelete) this.seenKeys.delete(k);
    }
    this.seenKeys.set(key, seq);
  }

  /* ------------------------------------------------------------------ */
  /*  Stale Execution Cleanup                                            */
  /* ------------------------------------------------------------------ */

  private cleanupStaleExecutions(): void {
    const now = Date.now();
    for (const [, execution] of this.executions) {
      if (execution.status === 'paused') {
        if (execution.pausedAt !== undefined && now - execution.pausedAt > MAX_PAUSE_DURATION_MS) {
          this.finalizeExecution(execution, 'timedOut', 'Paused for ' + MAX_PAUSE_DURATION_MS + 'ms');
        }
        continue;
      }
      if (execution.status !== 'running') continue;
      if (now - execution.lastActivityAt > EXECUTION_TIMEOUT_MS) {
        this.finalizeExecution(execution, 'timedOut', 'No activity for ' + EXECUTION_TIMEOUT_MS + 'ms');
      }
    }

    /* Evict oldest terminated executions when total exceeds limit */
    if (this.executions.size > MAX_EXECUTIONS * 2) {
      const terminated = [...this.executions.entries()]
        .filter(([, e]) => e.status !== 'running' && e.status !== 'paused')
        .sort(([, a], [, b]) => (a.endTime ?? a.createdAt) - (b.endTime ?? b.createdAt));
      const toRemove = terminated.slice(0, Math.floor(MAX_EXECUTIONS * 0.5));
      for (const [id, ex] of toRemove) {
        for (const pe of ex.events) {
          const tid = pe.event.traceId;
          if (tid) this.traceIdIndex.get(tid)?.delete(pe);
        }
        this.pipelineDependencies.delete(id);
        const uriSet = this.executionsByUri.get(ex.uri);
        if (uriSet) {
          uriSet.delete(id);
          if (uriSet.size === 0) this.executionsByUri.delete(ex.uri);
        }
        this.executions.delete(id);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Statistics & Helpers                                               */
  /* ------------------------------------------------------------------ */

  private updatePeakConcurrent(): void {
    const active = this.getActiveCount();
    if (active > this.peakConcurrent) {
      this.peakConcurrent = active;
    }
  }

  private accumulateStageDuration(stage: string, durationMs: number): void {
    let acc = this.stageDurationAccumulators[stage];
    if (!acc) {
      acc = { count: 0, totalMs: 0, peakMs: 0 };
      this.stageDurationAccumulators[stage] = acc;
    }
    acc.count++;
    acc.totalMs += durationMs;
    if (durationMs > acc.peakMs) acc.peakMs = durationMs;
  }

  private getActiveCount(): number {
    let count = 0;
    for (const [, ex] of this.executions) {
      if (ex.status === 'running' || ex.status === 'paused') count++;
    }
    return count;
  }

  /* ------------------------------------------------------------------ */
  /*  Telemetry Emission                                                 */
  /* ------------------------------------------------------------------ */

  private emitExecutionStarted(execution: PipelineExecution, trigger: string, provider?: string): void {
    this.safeReport({
      type: 'pipeline.execution.started',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      pipelineId: execution.id,
      uri: execution.uri,
      trigger,
      provider,
    } as any);
  }

  private emitExecutionCompleted(execution: PipelineExecution): void {
    this.safeReport({
      type: 'pipeline.execution.completed',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      pipelineId: execution.id,
      uri: execution.uri,
      durationMs: execution.durationMs ?? 0,
      stageCount: execution.stages.size,
      eventCount: execution.events.length,
      status: execution.status,
      error: execution.error,
    } as any);
  }

  private emitCorrelation(pipelineId: PipelineId, relatedPipelineId: PipelineId, relation: 'parent-child' | 'traceId' | 'causal', traceIds: string[]): void {
    this.safeReport({
      type: 'pipeline.correlation',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      pipelineId,
      relatedPipelineId,
      relation,
      traceIds,
    } as any);
  }

  private emitStageEvent(execution: PipelineExecution, stage: string, status: StageStatus, durationMs?: number, error?: string): void {
    this.safeReport({
      type: 'pipeline.stage',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      pipelineId: execution.id,
      uri: execution.uri,
      stage,
      status,
      durationMs,
      error,
    } as any);
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  getStatistics(): PipelineStatistics {
    const elapsedSec = (Date.now() - this.statsStarted) / 1000;
    const active = this.getActiveCount();
    const total = this.totalCompleted + this.totalFailed + this.totalCancelled + this.totalTimedOut;

    const stageDurations: Record<string, { count: number; totalMs: number; peakMs: number; averageMs: number }> = {};
    for (const [name, acc] of Object.entries(this.stageDurationAccumulators)) {
      stageDurations[name] = {
        ...acc,
        averageMs: acc.count > 0 ? Math.round(acc.totalMs / acc.count) : 0,
      };
    }

    let totalDurationMs = 0;
    let durationCount = 0;
    let peakDurationMs = 0;
    for (const [, ex] of this.executions) {
      if (ex.durationMs !== undefined && ex.status === 'completed') {
        totalDurationMs += ex.durationMs;
        durationCount++;
        if (ex.durationMs > peakDurationMs) peakDurationMs = ex.durationMs;
      }
    }

    return {
      totalExecutions: this.totalStarted,
      completedExecutions: this.totalCompleted,
      failedExecutions: this.totalFailed,
      cancelledExecutions: this.totalCancelled,
      timedOutExecutions: this.totalTimedOut,
      totalEvents: this.eventsProcessed,
      averagePipelineDurationMs: durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0,
      peakPipelineDurationMs: peakDurationMs,
      stageDurations,
      concurrentPipelinePeak: this.peakConcurrent,
      pipelineThroughput: elapsedSec > 0 ? Math.round((total / elapsedSec) * 1000) : 0,
      activeExecutions: active,
      durationHistogram: computeHistogram(this.durationSamples),
    };
  }

  captureSnapshot(): PipelineSnapshot {
    return {
      activeExecutions: this.getActiveCount(),
      totalExecutions: this.executions.size,
      completedExecutions: this.totalCompleted,
      failedExecutions: this.totalFailed,
      statistics: this.getStatistics(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Correlation API                                                    */
  /* ------------------------------------------------------------------ */

  getEventsByTraceId(traceId: string): PipelineEvent[] {
    const set = this.traceIdIndex.get(traceId);
    return set ? [...set] : [];
  }

  getExecutionsByTraceId(traceId: string): PipelineExecution[] {
    const set = this.traceIdIndex.get(traceId);
    if (!set || set.size === 0) return [];
    const seen = new Set<PipelineId>();
    const result: PipelineExecution[] = [];
    for (const pe of set) {
      if (!seen.has(pe.pipelineId)) {
        seen.add(pe.pipelineId);
        const ex = this.executions.get(pe.pipelineId);
        if (ex) result.push(ex);
      }
    }
    return result;
  }

  getCausalChain(traceId: string, maxDepth = 100): CausalChain {
    const links: CausalChainLink[] = [];
    let currentTraceId: string | undefined = traceId;
    let depth = 0;
    let rootTraceId = traceId;
    const visited = new Set<string>();

    while (currentTraceId && depth < maxDepth) {
      if (visited.has(currentTraceId)) break;
      visited.add(currentTraceId);

      const eventSet = this.traceIdIndex.get(currentTraceId);
      if (!eventSet || eventSet.size === 0) break;

      let pe: PipelineEvent | undefined;
      for (const candidate of eventSet) {
        if (!pe || candidate.seq < pe.seq) pe = candidate;
      }
      if (!pe) break;
      const parentTraceId = pe.event.parentTraceId;

      links.push({
        pipelineId: pe.pipelineId,
        pipelineEvent: pe,
        traceId: currentTraceId,
        parentTraceId,
        depth,
      });

      if (!parentTraceId) rootTraceId = currentTraceId;
      currentTraceId = parentTraceId;
      depth++;
    }

    return { rootTraceId, links, depth };
  }

  getDependencyGraph(): Map<PipelineId, PipelineId[]> {
    const result = new Map<PipelineId, PipelineId[]>();
    for (const [child, parents] of this.pipelineDependencies) {
      result.set(child, [...parents]);
    }
    return result;
  }

  getParentPipelines(pipelineId: PipelineId): PipelineId[] {
    const deps = this.pipelineDependencies.get(pipelineId);
    return deps ? [...deps] : [];
  }

  /* ------------------------------------------------------------------ */
  /*  Execution Lifecycle Control                                        */
  /* ------------------------------------------------------------------ */

  pauseExecution(pipelineId: PipelineId): boolean {
    const ex = this.executions.get(pipelineId);
    if (!ex || ex.status !== 'running') return false;
    ex.status = 'paused';
    ex.pausedAt = Date.now();
    ex.pauseCount++;
    ex.lastActivityAt = Date.now();

    this.safeReport({
      type: 'pipeline.execution.paused',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      pipelineId: ex.id,
      uri: ex.uri,
      pauseCount: ex.pauseCount,
    } as any);
    return true;
  }

  resumeExecution(pipelineId: PipelineId): boolean {
    const ex = this.executions.get(pipelineId);
    if (!ex || ex.status !== 'paused' || ex.pausedAt === undefined) return false;
    const pausedMs = Date.now() - ex.pausedAt;
    ex.pausedDurationMs += pausedMs;
    ex.pausedAt = undefined;
    ex.status = 'running';
    ex.lastActivityAt = Date.now();

    this.safeReport({
      type: 'pipeline.execution.resumed',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      pipelineId: ex.id,
      uri: ex.uri,
      totalPausedMs: ex.pausedDurationMs,
      pauseCount: ex.pauseCount,
    } as any);
    return true;
  }

  enableAssertions(): void { this.assertionsEnabled = true; }
  disableAssertions(): void { this.assertionsEnabled = false; }

  validate(pipelineId: PipelineId): PipelineAssertionViolation[] {
    const violations: PipelineAssertionViolation[] = [];
    if (!this.assertionsEnabled) return violations;
    const ex = this.executions.get(pipelineId);
    if (!ex) {
      violations.push({ pipelineId, rule: 'exists', message: 'Pipeline not found', timestamp: Date.now() });
      return violations;
    }
    const now = Date.now();

    if (ex.events.length === 0) {
      violations.push({ pipelineId, rule: 'hasEvents', message: 'Pipeline has no events', timestamp: now });
    }
    if (ex.status === 'completed' && ex.endTime && ex.endTime < ex.startTime) {
      violations.push({ pipelineId, rule: 'endTimeAfterStart', message: 'End time before start time', timestamp: now });
    }
    for (const stage of ex.stages.values()) {
      if (stage.status === 'completed' && stage.exitedAt && stage.exitedAt < stage.enteredAt) {
        violations.push({ pipelineId, rule: 'stageDurationPositive', message: `Stage ${stage.name} has negative duration`, timestamp: now });
      }
      if (stage.status === 'running' && ex.status === 'completed') {
        violations.push({ pipelineId, rule: 'stageCompleted', message: `Stage ${stage.name} still running after pipeline completion`, timestamp: now });
      }
    }
    if (ex.pauseCount > 0 && ex.pausedAt !== undefined && now - ex.pausedAt > MAX_PAUSE_DURATION_MS) {
      violations.push({ pipelineId, rule: 'noDeadlock', message: `Pipeline paused for extended period without resume`, timestamp: now });
    }

    return violations;
  }

  getPipelineTimeline(pipelineId: PipelineId): { events: PipelineEvent[]; stages: PipelineStage[]; execution: PipelineExecution | undefined } {
    const ex = this.executions.get(pipelineId);
    if (!ex) return { events: [], stages: [], execution: undefined };
    return {
      events: [...ex.events],
      stages: this.getStageTimeline(pipelineId),
      execution: ex,
    };
  }

  getFailures(pipelineId: PipelineId): PipelineFailure[] {
    const ex = this.executions.get(pipelineId);
    return ex ? [...ex.failures] : [];
  }

  getStageTimeline(pipelineId: PipelineId): PipelineStage[] {
    const ex = this.executions.get(pipelineId);
    if (!ex) return [];
    return ex.stageOrder.map((name) => ex.stages.get(name)!);
  }

  getStageSummary(pipelineId: PipelineId): { totalStages: number; completedStages: number; failedStages: number; skippedStages: number; totalDurationMs: number } | undefined {
    const ex = this.executions.get(pipelineId);
    if (!ex) return undefined;
    let completed = 0, failed = 0, skipped = 0, totalDuration = 0;
    for (const [, stage] of ex.stages) {
      if (stage.status === 'completed') completed++;
      if (stage.status === 'failed') failed++;
      if (stage.status === 'skipped') skipped++;
      if (stage.durationMs) totalDuration += stage.durationMs;
    }
    return { totalStages: ex.stages.size, completedStages: completed, failedStages: failed, skippedStages: skipped, totalDurationMs: totalDuration };
  }

  cancelExecution(pipelineId: PipelineId, reason?: string): boolean {
    const ex = this.executions.get(pipelineId);
    if (!ex || (ex.status !== 'running' && ex.status !== 'paused')) return false;
    this.finalizeExecution(ex, 'cancelled', reason);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Expose internal state structure sizes for diagnostics */
  getInternalStateSizes(): Record<string, number> {
    return {
      executions: this.executions.size,
      executionsByUri: this.executionsByUri.size,
      seenKeys: this.seenKeys.size,
      allEvents: this.allEvents.length,
      traceIdIndex: this.traceIdIndex.size,
      pipelineDependencies: this.pipelineDependencies.size,
      durationSamples: this.durationSamples.length,
      stageDurationAccumulators: Object.keys(this.stageDurationAccumulators).length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    clearInterval(this.staleTimer);
    this.executions.clear();
    this.executionsByUri.clear();
    this.seenKeys.clear();
    this.allEvents.length = 0;
    this.traceIdIndex.clear();
    this.pipelineDependencies.clear();
  }
}

/** Create an EventPipelineMonitor attached to the given reporter */
export function createEventPipelineMonitor(reporter: TelemetryReporter): EventPipelineMonitor {
  return new EventPipelineMonitor(reporter);
}
