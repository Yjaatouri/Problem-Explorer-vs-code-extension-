import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/** Known pipeline sequences (ordered list of event types) */
const PIPELINES: ReadonlyArray<{
  name: string;
  steps: readonly string[];
  windowMs: number;
}> = [
  {
    name: 'auto-scan-file-save',
    steps: [
      'autoscan.fileSaved',
      'autoscan.queue',
      'autoscan.flush',
      'provider.scan',
      'store.set',
      'folder.updateAncestors',
      'decoration.fireDidChange',
      'decoration.provideFileDecoration',
    ],
    windowMs: 15000,
  },
  {
    name: 'diagnostics-realtime',
    steps: [
      'diagnostics.change',
      'diagnostics.updateUri',
      'store.set',
      'folder.updateAncestors',
      'decoration.fireDidChange',
    ],
    windowMs: 5000,
  },
  {
    name: 'provider-lifecycle',
    steps: [
      'provider.lifecycle',
      'provider.scan',
      'store.set',
    ],
    windowMs: 30000,
  },
  {
    name: 'decoration-request',
    steps: [
      'decoration.fireDidChange',
      'decoration.provideFileDecoration',
    ],
    windowMs: 3000,
  },
];

/** Observed event with sequence context */
interface TrackedEvent {
  readonly seq: number;
  readonly event: TelemetryEvent;
  readonly receivedAt: number;
}

/** Active pipeline instance being tracked */
interface PipelineInstance {
  readonly pipelineName: string;
  readonly startedAt: number;
  readonly steps: string[];
  readonly matched: Array<{ stepIndex: number; event: TelemetryEvent; seq: number }>;
  readonly windowMs: number;
  complete: boolean;
}

/** Structured event payload for duplicate detection */
export interface PipelineDuplicateEventData {
  readonly type: 'pipeline.duplicateEvent';
  readonly eventType: string;
  readonly eventTraceId: string;
  readonly originalSeq: number;
  readonly duplicateSeq: number;
}

/** Structured event payload for out-of-order detection */
export interface PipelineOutOfOrderEventData {
  readonly type: 'pipeline.outOfOrder';
  readonly eventType: string;
  readonly eventTraceId: string;
  readonly expectedType: string | undefined;
  readonly sequenceGap: number;
}

/** Structured event payload for missing event detection */
export interface PipelineMissingEventData {
  readonly type: 'pipeline.missingEvent';
  readonly pipelineName: string;
  readonly missingStep: string;
  readonly afterStep: string;
  readonly windowMs: number;
  readonly source: string;
}

/** Structured event payload for periodic snapshot */
export interface PipelineSnapshotEventData {
  readonly type: 'pipeline.snapshot';
  readonly totalEvents: number;
  readonly eventsByType: Record<string, number>;
  readonly activePipelines: number;
  readonly completedPipelines: number;
  readonly eventsBySource: Record<string, number>;
  readonly executionTimeMs: number;
}

/** Union of all pipeline monitor event types */
export type EventPipelineMonitorEvent =
  | PipelineDuplicateEventData
  | PipelineOutOfOrderEventData
  | PipelineMissingEventData
  | PipelineSnapshotEventData;

const MAX_HISTORY = 2000;
const SNAPSHOT_INTERVAL_MS = 60000;

/** Monitors the event pipeline: tracks sequence, detects anomalies, and reports pipeline health */
export class EventPipelineMonitor {
  private seq = 0;
  private readonly history: TrackedEvent[] = [];
  private readonly eventCountByType = new Map<string, number>();
  private readonly eventCountBySource = new Map<string, number>();
  private readonly seenKeys = new Map<string, number>(); // type:traceId → seq
  private readonly pipelines: PipelineInstance[] = [];
  private completedPipelineCount = 0;
  private lastSnapshotTime = 0;
  private readonly snapshotIntervalMs: number;
  private disposed = false;
  private subscription: TelemetrySubscription | undefined;

  constructor(
    private readonly reporter: TelemetryReporter,
    snapshotIntervalMs: number = SNAPSHOT_INTERVAL_MS
  ) {
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.lastSnapshotTime = Date.now();
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('pipeline.')) return;
      this.processEvent(event);
      this.checkSnapshot();
    });
  }

  private processEvent(event: TelemetryEvent): void {
    const now = Date.now();
    const seq = ++this.seq;
    const eventType = event.type;
    const source = event.source ?? 'unknown';

    this.eventCountByType.set(eventType, (this.eventCountByType.get(eventType) ?? 0) + 1);
    this.eventCountBySource.set(source, (this.eventCountBySource.get(source) ?? 0) + 1);

    const tracked: TrackedEvent = { seq, event, receivedAt: now };
    this.history.push(tracked);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Check for potential start of a pipeline
    this.tryStartPipelines(event, seq);

    // Feed event to active pipelines
    this.feedPipelines(event, seq);

    // Detect duplicates: same event type + same traceId within 1s
    this.detectDuplicate(event, seq);

    // Detect out-of-order within traceId chain
    this.detectOutOfOrder(event, seq);

    // Detect missing events in aged-out pipelines
    this.detectMissing(now);
  }

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

  private detectOutOfOrder(event: TelemetryEvent, seq: number): void {
    if (this.history.length < 2) return;

    // Check if this event's timestamp is before the previous event in the same traceId chain
    for (let i = this.history.length - 2; i >= 0; i--) {
      const prev = this.history[i];
      if (prev.event.traceId === event.traceId) {
        if (event.timestamp < prev.event.timestamp) {
          const gap = seq - prev.seq;
      this.reporter.report({
        type: 'pipeline.outOfOrder',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'EventPipelineMonitor',
        eventType: event.type,
        eventTraceId: event.traceId,
        expectedType: prev.event.type,
        sequenceGap: gap,
      } as any);
        }
        break;
      }
    }
  }

  private tryStartPipelines(event: TelemetryEvent, seq: number): void {
    for (const def of PIPELINES) {
      if (def.steps.length === 0) continue;
      if (this.eventTypeMatches(event.type, def.steps[0])) {
        this.pipelines.push({
          pipelineName: def.name,
          startedAt: Date.now(),
          steps: [...def.steps],
          matched: [{ stepIndex: 0, event, seq }],
          windowMs: def.windowMs,
          complete: false,
        });
      }
    }
  }

  private eventTypeMatches(actual: string, expected: string): boolean {
    if (expected.endsWith('.*')) {
      return actual.startsWith(expected.slice(0, -2));
    }
    return actual === expected;
  }

  private feedPipelines(event: TelemetryEvent, seq: number): void {
    for (const pipe of this.pipelines) {
      if (pipe.complete) continue;
      const lastMatched = pipe.matched[pipe.matched.length - 1];
      const nextIndex = lastMatched.stepIndex + 1;
      if (nextIndex >= pipe.steps.length) {
        pipe.complete = true;
        this.completedPipelineCount++;
        continue;
      }
      if (this.eventTypeMatches(event.type, pipe.steps[nextIndex])) {
        pipe.matched.push({ stepIndex: nextIndex, event, seq });
        if (nextIndex === pipe.steps.length - 1) {
          pipe.complete = true;
          this.completedPipelineCount++;
        }
      }
    }
  }

  private detectMissing(now: number): void {
    const agedOut: PipelineInstance[] = [];
    for (const pipe of this.pipelines) {
      if (pipe.complete) continue;
      if (now - pipe.startedAt > pipe.windowMs) {
        agedOut.push(pipe);
        const lastMatched = pipe.matched[pipe.matched.length - 1];
        const nextIndex = lastMatched.stepIndex + 1;
        if (nextIndex < pipe.steps.length) {
          this.reporter.report({
            type: 'pipeline.missingEvent',
            timestamp: now,
            traceId: generateTraceId(),
            source: 'EventPipelineMonitor',
            pipelineName: pipe.pipelineName,
            missingStep: pipe.steps[nextIndex],
            afterStep: pipe.steps[nextIndex - 1],
            windowMs: pipe.windowMs,
          } as any);
        }
      }
    }
    for (const pipe of agedOut) {
      const idx = this.pipelines.indexOf(pipe);
      if (idx >= 0) this.pipelines.splice(idx, 1);
    }
  }

  private checkSnapshot(): void {
    const now = Date.now();
    if (now - this.lastSnapshotTime < this.snapshotIntervalMs) return;
    this.lastSnapshotTime = now;

    const byType: Record<string, number> = {};
    for (const [k, v] of this.eventCountByType) byType[k] = v;
    const bySource: Record<string, number> = {};
    for (const [k, v] of this.eventCountBySource) bySource[k] = v;

    this.reporter.report({
      type: 'pipeline.snapshot',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'EventPipelineMonitor',
      totalEvents: this.seq,
      eventsByType: byType,
      activePipelines: this.pipelines.filter((p) => !p.complete).length,
      completedPipelines: this.completedPipelineCount,
      eventsBySource: bySource,
      executionTimeMs: SNAPSHOT_INTERVAL_MS,
    } as any);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription?.dispose();
    this.history.length = 0;
    this.eventCountByType.clear();
    this.eventCountBySource.clear();
    this.seenKeys.clear();
    this.pipelines.length = 0;
  }
}

/** Create an EventPipelineMonitor attached to the given reporter */
export function createEventPipelineMonitor(
  reporter: TelemetryReporter,
  snapshotIntervalMs?: number
): EventPipelineMonitor {
  return new EventPipelineMonitor(reporter, snapshotIntervalMs);
}