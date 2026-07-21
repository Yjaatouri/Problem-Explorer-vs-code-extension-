import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/* ------------------------------------------------------------------ */
/*  Pipeline Identity                                                  */
/* ------------------------------------------------------------------ */

declare const PipelineIdBrand: unique symbol;
export type PipelineId = string & { readonly __brand: typeof PipelineIdBrand };

export function generatePipelineId(): PipelineId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` as PipelineId;
}

/* ------------------------------------------------------------------ */
/*  Pipeline Event                                                     */
/* ------------------------------------------------------------------ */

export type StageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled' | 'timedOut';

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

export type PipelineStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timedOut';

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
  readonly events: PipelineEvent[];
  error?: string;
  readonly createdAt: number;
  lastActivityAt: number;
}

/* ------------------------------------------------------------------ */
/*  Pipeline Statistics & Snapshot                                     */
/* ------------------------------------------------------------------ */

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

export type EventPipelineMonitorEvent =
  | PipelineExecutionStartedEventData
  | PipelineExecutionCompletedEventData
  | PipelineStageEventData
  | PipelineDuplicateEventData;

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const EXECUTION_TIMEOUT_MS = 60000;
const STALE_CHECK_INTERVAL_MS = 30000;
const MAX_EXECUTIONS = 500;
const MAX_EVENTS_PER_EXECUTION = 1000;
const MAX_EVENTS_TOTAL = 10000;

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

/* ------------------------------------------------------------------ */
/*  EventPipelineMonitor                                               */
/* ------------------------------------------------------------------ */

export class EventPipelineMonitor {
  private seq = 0;
  private readonly executions = new Map<PipelineId, PipelineExecution>();
  private readonly executionsByUri = new Map<string, Set<PipelineId>>();
  private readonly seenKeys = new Map<string, number>();
  private readonly allEvents: PipelineEvent[] = [];
  private readonly subscription: TelemetrySubscription;
  private readonly staleTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  /* Statistics */
  private statsStarted = Date.now();
  private peakConcurrent = 0;
  private readonly stageDurationAccumulators: Record<string, { count: number; totalMs: number; peakMs: number }> = {};
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalCancelled = 0;
  private totalTimedOut = 0;

  constructor(private readonly reporter: TelemetryReporter) {
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('pipeline.')) return;
      this.processEvent(event);
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
    this.detectDuplicate(event, seq);
    const execution = this.routeToExecution(event);
    if (!execution) return;
    this.addEventToExecution(execution, event, seq);
  }

  /** Route an event to the correct pipeline execution, creating one if needed */
  private routeToExecution(event: TelemetryEvent): PipelineExecution | undefined {
    const uri = extractUri(event);
    const key = uri ?? `__${event.source ?? 'unknown'}__`;

    /* Look for an active execution for this URI */
    const existingIds = this.executionsByUri.get(key);
    if (existingIds && existingIds.size > 0) {
      /* Find the most recent active execution */
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

    /* Check linked by traceId chain to an existing execution */
    if (event.parentTraceId) {
      for (const [, ex] of this.executions) {
        if (ex.status !== 'running') continue;
        for (const pe of ex.events) {
          if (pe.event.traceId === event.parentTraceId) {
            ex.lastActivityAt = Date.now();
            return ex;
          }
        }
      }
    }

    /* Create a new execution */
    return this.createExecution(event, key);
  }

  private createExecution(event: TelemetryEvent, key: string): PipelineExecution {
    const id = generatePipelineId();
    const uri = extractUri(event) ?? key;
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
      events: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.executions.set(id, execution);

    let uriSet = this.executionsByUri.get(key);
    if (!uriSet) {
      uriSet = new Set();
      this.executionsByUri.set(key, uriSet);
    }
    uriSet.add(id);

    /* Enforce execution cap */
    if (this.executions.size > MAX_EXECUTIONS) {
      const oldest = [...this.executions.entries()]
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        this.finalizeExecution(oldest[1], 'timedOut', 'Execution cap reached');
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

    /* Enforce event cap per execution */
    if (execution.events.length > MAX_EVENTS_PER_EXECUTION) {
      execution.events.splice(0, execution.events.length - MAX_EVENTS_PER_EXECUTION);
    }

    /* Enforce total event cap */
    if (this.allEvents.length > MAX_EVENTS_TOTAL) {
      const removed = this.allEvents.splice(0, this.allEvents.length - MAX_EVENTS_TOTAL);
      for (const re of removed) {
        const ex = this.executions.get(re.pipelineId);
        if (ex) {
          const idx = ex.events.indexOf(re);
          if (idx >= 0) ex.events.splice(idx, 1);
        }
      }
    }

    /* Track stage */
    this.updateStage(execution, stage, event);

    /* Track provider info */
    const provider = extractProvider(event);
    if (provider && !execution.provider) {
      execution.provider = provider;
    }

    execution.lastActivityAt = Date.now();

    /* Check for terminal events */
    if (event.type === 'decoration.fire' || event.type === 'autoscan.cancel') {
      this.finalizeExecution(execution, 'completed');
    }
    if (event.type === 'autoscan.cancel') {
      /* Already triggered by event type above */
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Stage Tracking                                                     */
  /* ------------------------------------------------------------------ */

  private updateStage(execution: PipelineExecution, stageName: string, event: TelemetryEvent): void {
    let stage = execution.stages.get(stageName);
    if (!stage) {
      stage = {
        name: stageName,
        enteredAt: Date.now(),
        status: 'running',
        eventTypes: [],
        eventSeqs: [],
      };
      execution.stages.set(stageName, stage);
      this.emitStageEvent(execution, stageName, 'running');
    }

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
    if (stage === 'store' && (eventType === 'store.endBatch' || eventType === 'store.set')) return true;
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
    if (execution.status !== 'running') return;
    execution.status = status;
    execution.endTime = Date.now();
    execution.durationMs = execution.endTime - execution.startTime;
    execution.error = error;

    /* Finalize any still-running stages */
    for (const [, stage] of execution.stages) {
      if (stage.status === 'running') {
        stage.exitedAt = execution.endTime;
        stage.durationMs = stage.exitedAt - stage.enteredAt;
        stage.status = status === 'completed' ? 'completed' : status;
        if (stage.durationMs > 0) {
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
      this.reporter.report({
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
    this.seenKeys.set(key, seq);
  }

  /* ------------------------------------------------------------------ */
  /*  Stale Execution Cleanup                                            */
  /* ------------------------------------------------------------------ */

  private cleanupStaleExecutions(): void {
    const now = Date.now();
    for (const [, execution] of this.executions) {
      if (execution.status !== 'running') continue;
      if (now - execution.lastActivityAt > EXECUTION_TIMEOUT_MS) {
        this.finalizeExecution(execution, 'timedOut', 'No activity for ' + EXECUTION_TIMEOUT_MS + 'ms');
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
      if (ex.status === 'running') count++;
    }
    return count;
  }

  /* ------------------------------------------------------------------ */
  /*  Telemetry Emission                                                 */
  /* ------------------------------------------------------------------ */

  private emitExecutionStarted(execution: PipelineExecution, trigger: string, provider?: string): void {
    this.reporter.report({
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
    this.reporter.report({
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

  private emitStageEvent(execution: PipelineExecution, stage: string, status: StageStatus, durationMs?: number, error?: string): void {
    this.reporter.report({
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
      totalExecutions: this.executions.size,
      completedExecutions: this.totalCompleted,
      failedExecutions: this.totalFailed,
      cancelledExecutions: this.totalCancelled,
      timedOutExecutions: this.totalTimedOut,
      totalEvents: this.seq,
      averagePipelineDurationMs: durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0,
      peakPipelineDurationMs: peakDurationMs,
      stageDurations,
      concurrentPipelinePeak: this.peakConcurrent,
      pipelineThroughput: elapsedSec > 0 ? Math.round((total / elapsedSec) * 1000) : 0,
      activeExecutions: active,
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
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    clearInterval(this.staleTimer);
    this.executions.clear();
    this.executionsByUri.clear();
    this.seenKeys.clear();
    this.allEvents.length = 0;
  }
}

/** Create an EventPipelineMonitor attached to the given reporter */
export function createEventPipelineMonitor(reporter: TelemetryReporter): EventPipelineMonitor {
  return new EventPipelineMonitor(reporter);
}
