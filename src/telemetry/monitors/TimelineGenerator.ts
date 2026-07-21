import * as fs from 'fs';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent, TraceId } from '../../telemetry/TelemetryEvent';
import { PipelineId } from './EventPipelineMonitor';

/* ------------------------------------------------------------------ */
/*  Timeline ID                                                        */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const TimelineIdBrand: unique symbol;
export type TimelineId = string & { readonly __brand: typeof TimelineIdBrand };

export function generateTimelineId(): TimelineId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` as TimelineId;
}

/* ------------------------------------------------------------------ */
/*  Timeline Status                                                   */
/* ------------------------------------------------------------------ */

export enum TimelineStatus {
  Live = 'live',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
  TimedOut = 'timedOut',
}

/* ------------------------------------------------------------------ */
/*  Timeline Event                                                     */
/* ------------------------------------------------------------------ */

export enum TimelineEventCategory {
  Store = 'store',
  Provider = 'provider',
  AutoScanner = 'autoscanner',
  Diagnostics = 'diagnostics',
  Folder = 'folder',
  Decoration = 'decoration',
  Pipeline = 'pipeline',
  Assertion = 'assertion',
  Snapshot = 'snapshot',
  Unknown = 'unknown',
}

export interface TimelineEvent {
  readonly seq: number;
  readonly event: TelemetryEvent;
  readonly category: TimelineEventCategory;
  readonly receivedAt: number;
  readonly pipelineId?: string;
  readonly uri?: string;
  readonly provider?: string;
  parentEventSeq?: number;
  readonly childEventSeqs: number[];
  previousEventSeq?: number;
  nextEventSeq?: number;
}

/* ------------------------------------------------------------------ */
/*  Timeline                                                           */
/* ------------------------------------------------------------------ */

export interface Timeline {
  readonly id: TimelineId;
  readonly traceIds: TraceId[];
  readonly primaryTraceId: TraceId;
  readonly startTime: number;
  endTime?: number;
  durationMs?: number;
  status: TimelineStatus;
  readonly events: TimelineEvent[];
  readonly pipelineIds: string[];
  readonly uris: string[];
  readonly providers: string[];
  readonly eventTypeCounts: Map<string, number>;
  hasAssertionFailure: boolean;
  hasPipelineFailure: boolean;
  hasProviderFailure: boolean;
  readonly createdAt: number;
  lastActivityAt: number;
  error?: string;
  parentTimelineId?: TimelineId;
  readonly childTimelineIds: TimelineId[];
}

/* ------------------------------------------------------------------ */
/*  Legacy interfaces (backward compat)                                */
/* ------------------------------------------------------------------ */

export interface TimelineEntry {
  readonly seq: number;
  readonly type: string;
  readonly source: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly phase?: string;
  readonly detail?: string;
}

export interface TimelineReport {
  readonly traceId: string;
  readonly entries: readonly TimelineEntry[];
  readonly totalDurationMs: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly missingEvents: readonly string[];
}

/* ------------------------------------------------------------------ */
/*  Timeline Statistics                                                */
/* ------------------------------------------------------------------ */

export interface TimelineStatistics {
  totalTimelines: number;
  liveTimelines: number;
  completedTimelines: number;
  failedTimelines: number;
  cancelledTimelines: number;
  timedOutTimelines: number;
  totalEvents: number;
  averageEventsPerTimeline: number;
  averageDurationMs: number;
  longestTimelineMs: number;
  incompleteTimelines: number;
  timelinesWithAssertionFailures: number;
  timelinesWithPipelineFailures: number;
}

/* ------------------------------------------------------------------ */
/*  Reconstruction Report                                              */
/* ------------------------------------------------------------------ */

export interface ReconstructionStep {
  readonly seq: number;
  readonly type: string;
  readonly timestamp: number;
  readonly category: TimelineEventCategory;
  readonly uri?: string;
  readonly provider?: string;
  readonly pipelineId?: string;
}

export interface ReconstructionReport {
  readonly timelineId: TimelineId;
  readonly status: TimelineStatus | 'unknown';
  readonly steps: readonly ReconstructionStep[];
  readonly missingSteps: readonly string[];
  readonly durationMs: number;
  readonly concurrentTimelines: readonly TimelineId[];
  readonly type: string;
  readonly eventCount: number;
  readonly hasError: boolean;
  readonly isPartial: boolean;
  readonly isConcurrent: boolean;
}

/* ------------------------------------------------------------------ */
/*  Known pipeline sequences for missing-event detection               */
/* ------------------------------------------------------------------ */

const PIPELINE_STEPS: ReadonlyArray<{
  name: string;
  steps: readonly string[];
}> = [
  {
    name: 'auto-scan',
    steps: ['autoscan.fileSaved', 'autoscan.queue', 'autoscan.flush', 'provider.scan', 'store.set', 'folder.updateAncestors', 'decoration.fireDidChange', 'decoration.provideFileDecoration'],
  },
  {
    name: 'diagnostics',
    steps: ['diagnostics.change', 'diagnostics.updateUri', 'store.set', 'folder.updateAncestors', 'decoration.fireDidChange'],
  },
  {
    name: 'decoration',
    steps: ['decoration.fireDidChange', 'decoration.provideFileDecoration'],
  },
  {
    name: 'provider-refresh',
    steps: ['provider.lifecycle', 'provider.scan', 'store.set'],
  },
];

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_TIMELINES = 500;
const MAX_EVENTS_PER_TIMELINE = 2000;
const MAX_TRACE_ENTRIES = 2000;
const STALE_TIMELINE_TIMEOUT_MS = 120000;
const STALE_CHECK_INTERVAL_MS = 30000;

/* ------------------------------------------------------------------ */
/*  TimelineGenerator                                                  */
/* ------------------------------------------------------------------ */

export class TimelineGenerator {
  protected readonly timelines = new Map<TimelineId, Timeline>();
  protected readonly timelineOrder: TimelineId[] = [];
  protected readonly eventsByTraceId = new Map<string, TelemetryEvent[]>();
  protected readonly traceOrder: string[] = [];
  protected readonly subscription: TelemetrySubscription;
  protected readonly staleTimer: ReturnType<typeof setInterval>;
  protected disposed = false;
  protected seq = 0;

  /* Statistics */
  protected totalCreated = 0;
  protected totalReconstructionTimeMs = 0;
  protected reconstructionCount = 0;

  constructor(reporter: TelemetryReporter) {
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      try {
        if (this.disposed) return;
        this.processGlobalEvent(event);
      } catch { /* non-critical */ }
    });
    this.staleTimer = setInterval(() => {
      this.cleanupStaleTimelines();
    }, STALE_CHECK_INTERVAL_MS);
  }

  /* ------------------------------------------------------------------ */
  /*  Global Event Processing                                            */
  /* ------------------------------------------------------------------ */

  protected processGlobalEvent(event: TelemetryEvent): void {
    if (event.type.startsWith('perf.') || event.type.startsWith('timeline.')) return;

    let chain = this.eventsByTraceId.get(event.traceId);
    if (!chain) {
      chain = [];
      this.eventsByTraceId.set(event.traceId, chain);
      this.traceOrder.push(event.traceId);
      if (this.traceOrder.length > MAX_TRACE_ENTRIES) {
        const oldestTrace = this.traceOrder.shift()!;
        this.eventsByTraceId.delete(oldestTrace);
      }
    }
    chain.push(event);

    if (!this.hasTimelineForTrace(event.traceId)) {
      this.createTimelineFromEvent(event);
    }

    this.routeEventToTimeline(event);
  }

  protected hasTimelineForTrace(traceId: TraceId): boolean {
    for (const tl of this.timelines.values()) {
      if (tl.traceIds.includes(traceId)) return true;
    }
    return false;
  }

  protected createTimelineFromEvent(event: TelemetryEvent): TimelineId {
    const id = generateTimelineId();
    const primaryTraceId = event.traceId;
    const now = Date.now();

    const timeline: Timeline = {
      id,
      traceIds: [primaryTraceId],
      primaryTraceId,
      startTime: now,
      status: TimelineStatus.Live,
      events: [],
      pipelineIds: [],
      uris: [],
      providers: [],
      eventTypeCounts: new Map(),
      hasAssertionFailure: false,
      hasPipelineFailure: false,
      hasProviderFailure: false,
      createdAt: now,
      lastActivityAt: now,
      childTimelineIds: [],
    };

    this.timelines.set(id, timeline);
    this.totalCreated++;
    this.timelineOrder.push(id);

    if (this.timelineOrder.length > MAX_TIMELINES) {
      const oldest = this.timelineOrder.shift()!;
      const evicted = this.timelines.get(oldest);
      if (evicted) {
        for (const tid of evicted.traceIds) {
          this.eventsByTraceId.delete(tid);
        }
      }
      this.timelines.delete(oldest);
    }

    return id;
  }

  protected routeEventToTimeline(event: TelemetryEvent): void {
    let best: Timeline | undefined;
    let bestScore = -1;

    for (const tl of this.timelines.values()) {
      let score = 0;
      if (tl.status !== TimelineStatus.Live) continue;
      if (tl.traceIds.includes(event.traceId)) score += 10;
      if (event.parentTraceId && tl.traceIds.includes(event.parentTraceId)) score += 8;
      const uri = this.extractUri(event);
      if (uri && tl.uris.includes(uri)) score += 5;
      const provider = this.extractProvider(event);
      if (provider && tl.providers.includes(provider)) score += 3;
      if (score > bestScore) {
        bestScore = score;
        best = tl;
      }
    }

    if (best) {
      this.addEventToTimeline(best, event);
      return;
    }

    let traceInTerminatedTimeline = false;
    for (const tl of this.timelines.values()) {
      if (tl.status === TimelineStatus.Live) continue;
      if (tl.traceIds.includes(event.traceId)) {
        traceInTerminatedTimeline = true;
        break;
      }
    }

    if (traceInTerminatedTimeline) {
      const newId = this.createTimelineFromEvent(event);
      const fresh = this.timelines.get(newId);
      if (fresh) this.addEventToTimeline(fresh, event);
    } else {
      const latest = this.timelines.get(this.timelineOrder[this.timelineOrder.length - 1]);
      if (latest) this.addEventToTimeline(latest, event);
    }
  }

  protected addEventToTimeline(timeline: Timeline, event: TelemetryEvent): void {
    const seq = ++this.seq;
    const category = this.categorizeEvent(event.type);
    const uri = this.extractUri(event);
    const provider = this.extractProvider(event);

    const tlEvent: TimelineEvent = {
      seq,
      event,
      category,
      receivedAt: Date.now(),
      pipelineId: this.extractPipelineId(event),
      uri,
      provider,
      childEventSeqs: [],
    };

    const lastEvent = timeline.events[timeline.events.length - 1];
    if (lastEvent) {
      tlEvent.previousEventSeq = lastEvent.seq;
      lastEvent.nextEventSeq = tlEvent.seq;
    }

    if (event.parentTraceId) {
      for (const pe of timeline.events) {
        if (pe.event.traceId === event.parentTraceId) {
          tlEvent.parentEventSeq = pe.seq;
          pe.childEventSeqs.push(tlEvent.seq);
          break;
        }
      }
      if (tlEvent.parentEventSeq === undefined) {
        for (const [otherId, other] of this.timelines) {
          if (otherId === timeline.id) continue;
          if (other.traceIds.includes(event.parentTraceId)) {
            timeline.parentTimelineId = otherId;
            if (!other.childTimelineIds.includes(timeline.id)) {
              other.childTimelineIds.push(timeline.id);
            }
            break;
          }
        }
      }
    }

    timeline.events.push(tlEvent);
    timeline.lastActivityAt = Date.now();

    if (uri && !timeline.uris.includes(uri)) timeline.uris.push(uri);
    if (provider && !timeline.providers.includes(provider)) timeline.providers.push(provider);
    if (tlEvent.pipelineId && !timeline.pipelineIds.includes(tlEvent.pipelineId)) timeline.pipelineIds.push(tlEvent.pipelineId);
    if (!timeline.traceIds.includes(event.traceId)) timeline.traceIds.push(event.traceId);

    timeline.eventTypeCounts.set(event.type, (timeline.eventTypeCounts.get(event.type) ?? 0) + 1);

    if (event.type === 'assertion.failure') {
      timeline.hasAssertionFailure = true;
      if (provider) timeline.hasProviderFailure = true;
    }
    if (event.type === 'pipeline.execution.failed') {
      timeline.hasPipelineFailure = true;
      if (provider) timeline.hasProviderFailure = true;
    }

    const phase = (event as any).phase;
    if (phase === 'error' || phase === 'cancelled') {
      if (category === TimelineEventCategory.Provider) timeline.hasProviderFailure = true;
    }

    if (this.isTerminalEvent(event) && timeline.status === TimelineStatus.Live) {
      const endTime = Date.now();
      timeline.endTime = endTime;
      timeline.durationMs = endTime - timeline.startTime;
      timeline.status = this.isFailureEvent(event) ? TimelineStatus.Failed : TimelineStatus.Completed;
      if (phase === 'cancelled') timeline.status = TimelineStatus.Cancelled;
    }

    if (timeline.events.length > MAX_EVENTS_PER_TIMELINE) {
      const removeCount = timeline.events.length - MAX_EVENTS_PER_TIMELINE;
      const removed = timeline.events.splice(0, removeCount);
      const removedSeqs = new Set(removed.map((e) => e.seq));
      for (const remaining of timeline.events) {
        if (remaining.previousEventSeq !== undefined && removedSeqs.has(remaining.previousEventSeq)) {
          remaining.previousEventSeq = undefined;
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
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  protected categorizeEvent(type: string): TimelineEventCategory {
    if (type.startsWith('store.')) return TimelineEventCategory.Store;
    if (type.startsWith('provider.')) return TimelineEventCategory.Provider;
    if (type.startsWith('autoscan.')) return TimelineEventCategory.AutoScanner;
    if (type.startsWith('diagnostics.')) return TimelineEventCategory.Diagnostics;
    if (type.startsWith('folder.')) return TimelineEventCategory.Folder;
    if (type.startsWith('decoration.')) return TimelineEventCategory.Decoration;
    if (type.startsWith('pipeline.')) return TimelineEventCategory.Pipeline;
    if (type.startsWith('assertion.')) return TimelineEventCategory.Assertion;
    if (type.startsWith('snapshot.')) return TimelineEventCategory.Snapshot;
    return TimelineEventCategory.Unknown;
  }

  protected extractUri(event: TelemetryEvent): string | undefined {
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

  protected extractProvider(event: TelemetryEvent): string | undefined {
    const data = event as unknown as Record<string, unknown>;
    if (typeof data.provider === 'string') return data.provider;
    if (typeof data.providerName === 'string') return data.providerName;
    return undefined;
  }

  protected extractPipelineId(event: TelemetryEvent): PipelineId | undefined {
    const data = event as unknown as Record<string, unknown>;
    if (typeof data.pipelineId === 'string') return data.pipelineId as PipelineId;
    return undefined;
  }

  protected isTerminalEvent(event: TelemetryEvent): boolean {
    return event.type === 'decoration.fire'
      || event.type === 'autoscan.cancel'
      || event.type === 'pipeline.execution.completed'
      || event.type === 'pipeline.execution.failed'
      || event.type === 'pipeline.execution.cancelled';
  }

  protected isFailureEvent(event: TelemetryEvent): boolean {
    const data = event as unknown as Record<string, unknown>;
    return data.phase === 'error' || data.phase === 'cancelled' || event.type === 'assertion.failure' || event.type === 'pipeline.execution.failed';
  }

  /* ------------------------------------------------------------------ */
  /*  Timeline Query API                                                 */
  /* ------------------------------------------------------------------ */

  createTimeline(): TimelineId {
    const id = generateTimelineId();
    const ts = Date.now();

    const timeline: Timeline = {
      id,
      traceIds: [],
      primaryTraceId: '' as TraceId,
      startTime: ts,
      status: TimelineStatus.Live,
      events: [],
      pipelineIds: [],
      uris: [],
      providers: [],
      eventTypeCounts: new Map(),
      hasAssertionFailure: false,
      hasPipelineFailure: false,
      hasProviderFailure: false,
      createdAt: ts,
      lastActivityAt: ts,
      childTimelineIds: [],
    };

    this.timelines.set(id, timeline);
    this.totalCreated++;
    this.timelineOrder.push(id);
    return id;
  }

  getTimeline(id: TimelineId): Timeline | undefined {
    return this.timelines.get(id);
  }

  listTimelines(): readonly Timeline[] {
    return [...this.timelines.values()];
  }

  deleteTimeline(id: TimelineId): boolean {
    const tl = this.timelines.get(id);
    if (!tl) return false;
    for (const tid of tl.traceIds) {
      this.eventsByTraceId.delete(tid);
    }
    this.timelines.delete(id);
    const idx = this.timelineOrder.indexOf(id);
    if (idx >= 0) this.timelineOrder.splice(idx, 1);
    return true;
  }

  finalizeTimeline(id: TimelineId, status: TimelineStatus.Completed | TimelineStatus.Failed | TimelineStatus.Cancelled | TimelineStatus.TimedOut, error?: string): boolean {
    const tl = this.timelines.get(id);
    if (!tl) return false;
    const nowMs = Date.now();
    tl.endTime = nowMs;
    tl.durationMs = nowMs - tl.startTime;
    tl.status = status;
    if (error) tl.error = error;
    return true;
  }

  recordEvent(event: TelemetryEvent): void {
    if (this.disposed) return;
    this.processGlobalEvent(event);
  }

  getLiveTimelines(): readonly Timeline[] {
    return [...this.timelines.values()].filter((t) => t.status === TimelineStatus.Live);
  }

  getHistoricalTimelines(): readonly Timeline[] {
    return [...this.timelines.values()].filter((t) => t.status !== TimelineStatus.Live);
  }

  /* ------------------------------------------------------------------ */
  /*  Event Correlation API                                              */
  /* ------------------------------------------------------------------ */

  getEventsByPipelineId(pipelineId: string): TimelineEvent[] {
    const result: TimelineEvent[] = [];
    for (const tl of this.timelines.values()) {
      for (const ev of tl.events) {
        if (ev.pipelineId === pipelineId) result.push(ev);
      }
    }
    return result;
  }

  getEventsByUri(uri: string): TimelineEvent[] {
    const result: TimelineEvent[] = [];
    for (const tl of this.timelines.values()) {
      for (const ev of tl.events) {
        if (ev.uri === uri) result.push(ev);
      }
    }
    return result;
  }

  getEventsByProvider(provider: string): TimelineEvent[] {
    const result: TimelineEvent[] = [];
    for (const tl of this.timelines.values()) {
      for (const ev of tl.events) {
        if (ev.provider === provider) result.push(ev);
      }
    }
    return result;
  }

  reconstructExecutionOrder(timelineId: TimelineId): TimelineEvent[] {
    const tl = this.timelines.get(timelineId);
    if (!tl) return [];
    return [...tl.events].sort((a, b) => {
      if (a.event.timestamp !== b.event.timestamp) return a.event.timestamp - b.event.timestamp;
      return a.seq - b.seq;
    });
  }

  getCorrelatedTimelines(timelineId: TimelineId): { parents: TimelineId[]; children: TimelineId[]; siblings: TimelineId[] } {
    const tl = this.timelines.get(timelineId);
    if (!tl) return { parents: [], children: [], siblings: [] };

    const parents: TimelineId[] = [];
    const children: TimelineId[] = [];
    const siblings: TimelineId[] = [];

    const allParentTraceIds = new Set<string>();
    for (const ev of tl.events) {
      if (ev.event.parentTraceId) allParentTraceIds.add(ev.event.parentTraceId);
    }
    const allChildTraceIds = new Set<string>();
    for (const ev of tl.events) {
      allChildTraceIds.add(ev.event.traceId);
    }

    for (const [otherId, other] of this.timelines) {
      if (otherId === timelineId) continue;

      for (const otherEv of other.events) {
        if (allParentTraceIds.has(otherEv.event.traceId)) {
          if (!parents.includes(otherId)) parents.push(otherId);
        }
        if (allChildTraceIds.has(otherEv.event.parentTraceId ?? '')) {
          if (!children.includes(otherId)) children.push(otherId);
        }
      }

      if (other.uris.some((u) => tl.uris.includes(u)) && !parents.includes(otherId) && !children.includes(otherId)) {
        const timeDelta = Math.abs(tl.startTime - other.startTime);
        if (timeDelta < 30000 && !siblings.includes(otherId)) siblings.push(otherId);
      }
    }

    return { parents, children, siblings };
  }

  /* ------------------------------------------------------------------ */
  /*  Timeline Reconstruction                                            */
  /* ------------------------------------------------------------------ */

  reconstructTimeline(timelineId: TimelineId): ReconstructionReport {
    const reconStart = Date.now();
    const tl = this.timelines.get(timelineId);
    if (!tl) {
      return { timelineId, status: 'unknown', steps: [], missingSteps: [], durationMs: 0, concurrentTimelines: [], type: 'unknown', eventCount: 0, hasError: false, isPartial: false, isConcurrent: false };
    }

    const sortedEvents = [...tl.events].sort((a, b) => a.event.timestamp - b.event.timestamp);
    const eventTypes = sortedEvents.map((e) => e.event.type);

    const matchedPath = this.matchExecutionPath(eventTypes);
    const missingSteps = this.findMissingSteps(eventTypes, matchedPath?.path ?? []);
    const isPartial = this.isPartialExecution(eventTypes);
    const hasError = tl.hasAssertionFailure || tl.hasPipelineFailure || tl.hasProviderFailure;
    const isConcurrent = this.detectConcurrency(tl);

    const concurrentTimelines: TimelineId[] = [];
    for (const [otherId, other] of this.timelines) {
      if (otherId === timelineId) continue;
      if (this.rangesOverlap(tl, other)) {
        concurrentTimelines.push(otherId);
      }
    }

    const durationMs = tl.durationMs ?? (tl.events.length >= 2 ? sortedEvents[sortedEvents.length - 1].event.timestamp - sortedEvents[0].event.timestamp : 0);

    const type = matchedPath?.name ?? (hasError ? 'failed' : 'unknown');

    const steps = sortedEvents.map((ev, i) => ({
      seq: i + 1,
      type: ev.event.type,
      timestamp: ev.event.timestamp,
      category: ev.category,
      uri: ev.uri,
      provider: ev.provider,
      pipelineId: ev.pipelineId,
    }));

    const reconTime = Date.now() - reconStart;
    this.totalReconstructionTimeMs += reconTime;
    this.reconstructionCount++;

    return {
      timelineId,
      status: tl.status,
      steps,
      missingSteps,
      durationMs,
      concurrentTimelines,
      type,
      eventCount: tl.events.length,
      hasError,
      isPartial,
      isConcurrent: isConcurrent || concurrentTimelines.length > 0,
    };
  }

  protected matchExecutionPath(eventTypes: string[]): { name: string; path: readonly string[] } | undefined {
    const eventSet = new Set(eventTypes);
    for (const candidate of PIPELINE_STEPS) {
      let longestRun = 0;
      let currentRun = 0;
      for (const step of candidate.steps) {
        if (eventSet.has(step)) {
          currentRun++;
          if (currentRun > longestRun) longestRun = currentRun;
        } else {
          currentRun = 0;
        }
      }
      const minRequired = Math.min(2, Math.ceil(candidate.steps.length * 0.75));
      if (longestRun >= minRequired) {
        return { name: candidate.name, path: candidate.steps };
      }
    }
    return undefined;
  }

  protected findMissingSteps(eventTypes: string[], expectedPath: readonly string[]): string[] {
    const missing: string[] = [];
    const seen = new Set(eventTypes);
    for (const step of expectedPath) {
      if (!seen.has(step)) missing.push(step);
    }
    return missing;
  }

  protected isPartialExecution(eventTypes: string[]): boolean {
    if (eventTypes.length === 0) return true;
    const terminalTypes = ['decoration.fire', 'decoration.provideFileDecoration', 'autoscan.cancel', 'pipeline.execution.completed', 'pipeline.execution.failed', 'pipeline.execution.cancelled'];
    for (const t of terminalTypes) {
      if (eventTypes.includes(t)) return false;
    }
    const nonMeta = eventTypes.filter((t) => !t.startsWith('timeline.') && !t.startsWith('pipeline.'));
    return nonMeta.length > 0;
  }

  protected detectConcurrency(timeline: Timeline): boolean {
    const timestamps = timeline.events.map((e) => e.event.timestamp).sort();
    if (timestamps.length < 6) return false;
    let clusters = 0;
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] - timestamps[i - 1] > 500) clusters++;
    }
    return clusters >= 4;
  }

  /* ------------------------------------------------------------------ */
  /*  Timeline Query API                                                 */
  /* ------------------------------------------------------------------ */

  getTimelineByPipeline(pipelineId: string): Timeline | undefined {
    for (const tl of this.timelines.values()) {
      if (tl.pipelineIds.includes(pipelineId)) return tl;
    }
    return undefined;
  }

  getTimelineByUri(uri: string): Timeline | undefined {
    for (const tl of this.timelines.values()) {
      if (tl.uris.includes(uri)) return tl;
    }
    return undefined;
  }

  getTimelineByProvider(provider: string): Timeline | undefined {
    for (const tl of this.timelines.values()) {
      if (tl.providers.includes(provider)) return tl;
    }
    return undefined;
  }

  getActiveTimelines(): readonly Timeline[] {
    return this.getLiveTimelines();
  }

  getFailedTimelines(): readonly Timeline[] {
    return [...this.timelines.values()].filter((t) => t.status === TimelineStatus.Failed || t.hasAssertionFailure || t.hasPipelineFailure || t.hasProviderFailure);
  }

  getStatistics(): TimelineStatistics {
    const all = [...this.timelines.values()];
    let liveCount = 0, completedCount = 0, failedCount = 0, cancelledCount = 0, timedOutCount = 0;
    let totalEvents = 0, totalDurationMs = 0, longestMs = 0;
    let assertionFailures = 0, pipelineFailures = 0, incomplete = 0;

    for (const tl of all) {
      switch (tl.status) {
        case TimelineStatus.Live: liveCount++; break;
        case TimelineStatus.Completed: completedCount++; break;
        case TimelineStatus.Failed: failedCount++; break;
        case TimelineStatus.Cancelled: cancelledCount++; break;
        case TimelineStatus.TimedOut: timedOutCount++; break;
      }
      totalEvents += tl.events.length;
      if (tl.durationMs !== undefined) {
        totalDurationMs += tl.durationMs;
        if (tl.durationMs > longestMs) longestMs = tl.durationMs;
      }
      if (tl.status === TimelineStatus.Live) incomplete++;
      if (tl.hasAssertionFailure) assertionFailures++;
      if (tl.hasPipelineFailure) pipelineFailures++;
    }

    const terminatedCount = completedCount + failedCount + cancelledCount + timedOutCount;

    return {
      totalTimelines: this.totalCreated,
      liveTimelines: liveCount,
      completedTimelines: completedCount,
      failedTimelines: failedCount,
      cancelledTimelines: cancelledCount,
      timedOutTimelines: timedOutCount,
      totalEvents,
      averageEventsPerTimeline: all.length > 0 ? Math.round(totalEvents / all.length) : 0,
      averageDurationMs: terminatedCount > 0 ? Math.round(totalDurationMs / terminatedCount) : 0,
      longestTimelineMs: longestMs,
      incompleteTimelines: incomplete,
      timelinesWithAssertionFailures: assertionFailures,
      timelinesWithPipelineFailures: pipelineFailures,
    };
  }

  protected rangesOverlap(a: Timeline, b: Timeline): boolean {
    const aStart = a.startTime;
    const aEnd = a.endTime ?? (a.events.length > 0 ? a.events[a.events.length - 1].event.timestamp : a.lastActivityAt);
    const bStart = b.startTime;
    const bEnd = b.endTime ?? (b.events.length > 0 ? b.events[b.events.length - 1].event.timestamp : b.lastActivityAt);
    return aStart < bEnd && bStart < aEnd;
  }

  /* ------------------------------------------------------------------ */
  /*  Legacy API (backward compat)                                       */
  /* ------------------------------------------------------------------ */

  getTraceIds(): readonly string[] {
    return [...this.traceOrder];
  }

  getEvents(traceId: string): readonly TelemetryEvent[] {
    return this.eventsByTraceId.get(traceId) ?? [];
  }

  generateReport(traceId: string): TimelineReport {
    const raw = this.eventsByTraceId.get(traceId);
    if (!raw || raw.length === 0) {
      return { traceId, entries: [], totalDurationMs: 0, warnings: [], errors: [], missingEvents: [] };
    }

    const sorted = [...raw].sort((a, b) => a.timestamp - b.timestamp);
    const entries: TimelineEntry[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      const durationMs = next ? next.timestamp - cur.timestamp : 0;
      const data = cur as any;

      let detail: string | undefined;
      let phase: string | undefined;

      if (data.phase) phase = data.phase;
      if (data.error) detail = data.error;
      else if (data.message) detail = data.message;
      else if (data.detail) detail = data.detail;

      if (data.phase === 'error' || data.phase === 'cancelled') {
        errors.push(`[${i + 1}] ${cur.type}: ${(data as any).error ?? data.message ?? 'Unknown'}`);
      }
      if (data.type === 'assertion.failure') {
        errors.push(`[${i + 1}] Assertion "${data.assertion}": ${data.detail}`);
      }
      if (durationMs > 5000) {
        warnings.push(`[${i + 1}] Long gap (${durationMs}ms) between ${cur.type} → ${next?.type ?? 'end'}`);
      }

      entries.push({ seq: i + 1, type: cur.type, source: cur.source ?? 'unknown', timestamp: cur.timestamp, durationMs, phase, detail });
    }

    const totalDurationMs = sorted.length >= 2 ? sorted[sorted.length - 1].timestamp - sorted[0].timestamp : 0;

    const seenTypes = new Set(sorted.map((e) => e.type));
    const missingEvents: string[] = [];
    for (const pipeline of PIPELINE_STEPS) {
      const matched: string[] = [];
      for (const step of pipeline.steps) {
        if (seenTypes.has(step)) {
          matched.push(step);
        }
      }
      if (matched.length > 0 && matched.length < pipeline.steps.length) {
        for (const step of pipeline.steps) {
          if (!seenTypes.has(step)) {
            missingEvents.push(`${pipeline.name}: missing "${step}" after "${matched[matched.length - 1]}"`);
          }
        }
      }
    }

    return { traceId, entries, totalDurationMs, warnings, errors, missingEvents };
  }

  generateForensicReport(traceId: string): string {
    const report = this.generateReport(traceId);
    const lines: string[] = [];
    const nowStr = new Date().toISOString();

    lines.push(`[TIMELINE:REPORT] ===== TIMELINE REPORT =====`);
    lines.push(`[TIMELINE:REPORT] Generated: ${nowStr}`);
    lines.push(`[TIMELINE:REPORT] TraceId: ${report.traceId}`);
    lines.push(`[TIMELINE:REPORT] Total duration: ${report.totalDurationMs}ms`);
    lines.push(`[TIMELINE:REPORT] Events: ${report.entries.length}`);
    lines.push(`[TIMELINE:REPORT] =============================`);

    if (report.entries.length === 0) {
      lines.push(`[TIMELINE:REPORT] (no events recorded for this traceId)`);
      lines.push(`[TIMELINE:REPORT] ===== END TIMELINE REPORT =====`);
      return lines.join('\n');
    }

    lines.push(``);
    lines.push(`[TIMELINE:REPORT] Event Sequence:`);
    lines.push(`[TIMELINE:REPORT] ----------------`);

    for (const entry of report.entries) {
      const time = new Date(entry.timestamp).toISOString().slice(11, 23);
      const dur = entry.durationMs > 0 ? ` [+${entry.durationMs}ms]` : '';
      const ph = entry.phase ? ` phase=${entry.phase}` : '';
      const det = entry.detail ? ` detail="${entry.detail}"` : '';
      lines.push(`[TIMELINE:REPORT]   #${String(entry.seq).padStart(3)} ${time}  ${entry.type}${ph}${det}${dur}`);
    }

    if (report.errors.length > 0) {
      lines.push(``);
      lines.push(`[TIMELINE:REPORT] Errors (${report.errors.length}):`);
      lines.push(`[TIMELINE:REPORT] ----------------------`);
      for (const err of report.errors) {
        lines.push(`[TIMELINE:REPORT]   ${err}`);
      }
    }

    if (report.warnings.length > 0) {
      lines.push(``);
      lines.push(`[TIMELINE:REPORT] Warnings (${report.warnings.length}):`);
      lines.push(`[TIMELINE:REPORT] ------------------------`);
      for (const w of report.warnings) {
        lines.push(`[TIMELINE:REPORT]   ${w}`);
      }
    }

    if (report.missingEvents.length > 0) {
      lines.push(``);
      lines.push(`[TIMELINE:REPORT] Missing Events (${report.missingEvents.length}):`);
      lines.push(`[TIMELINE:REPORT] ------------------------------`);
      for (const m of report.missingEvents) {
        lines.push(`[TIMELINE:REPORT]   ${m}`);
      }
    }

    lines.push(``);
    lines.push(`[TIMELINE:REPORT] ===== END TIMELINE REPORT =====`);
    return lines.join('\n');
  }

  static analyzeLogFile(filePath: string): string {
    let data: string;
    try {
      data = fs.readFileSync(filePath, 'utf8');
    } catch (e: any) {
      return `[TIMELINE:OFFLINE] Failed to read log file: ${e.message}`;
    }

    const lines = data.split('\n').filter(Boolean);
    const events: TelemetryEvent[] = [];
    let parseErrors = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.type && typeof parsed.timestamp === 'number') {
          events.push(parsed as TelemetryEvent);
        }
      } catch {
        parseErrors++;
      }
    }

    const traceIds = new Set(events.map((e) => e.traceId));
    const typeCounts = new Map<string, number>();
    const errors: string[] = [];
    let totalDuration = 0;
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (const e of events) {
      typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
      if (e.timestamp < minTime) minTime = e.timestamp;
      if (e.timestamp > maxTime) maxTime = e.timestamp;
      const data2 = e as any;
      if (data2.phase === 'error' || data2.phase === 'cancelled' || e.type === 'assertion.failure') {
        errors.push(`${e.type}[${e.traceId}]: ${data2.error ?? data2.detail ?? data2.message ?? ''}`);
      }
    }

    if (minTime < Infinity) totalDuration = maxTime - minTime;

    const lines2: string[] = [];
    lines2.push(`[TIMELINE:OFFLINE] ===== LOG FILE ANALYSIS =====`);
    lines2.push(`[TIMELINE:OFFLINE] File: ${filePath}`);
    lines2.push(`[TIMELINE:OFFLINE] Total lines: ${lines.length}`);
    lines2.push(`[TIMELINE:OFFLINE] Parsed events: ${events.length}`);
    lines2.push(`[TIMELINE:OFFLINE] Parse errors: ${parseErrors}`);
    lines2.push(`[TIMELINE:OFFLINE] Unique TraceIds: ${traceIds.size}`);
    lines2.push(`[TIMELINE:OFFLINE] Time span: ${new Date(minTime).toISOString()} → ${new Date(maxTime).toISOString()} (${totalDuration}ms)`);
    lines2.push(``);
    lines2.push(`[TIMELINE:OFFLINE] Event type breakdown:`);
    const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      lines2.push(`[TIMELINE:OFFLINE]   ${type}: ${count}`);
    }

    if (errors.length > 0) {
      lines2.push(``);
      lines2.push(`[TIMELINE:OFFLINE] Errors (${errors.length}):`);
      for (const err of errors) {
        lines2.push(`[TIMELINE:OFFLINE]   ${err}`);
      }
    }

    lines2.push(``);
    lines2.push(`[TIMELINE:OFFLINE] TraceIds:`);
    for (const tid of traceIds) {
      const count = events.filter((e) => e.traceId === tid).length;
      lines2.push(`[TIMELINE:OFFLINE]   ${tid}: ${count} events`);
    }

    lines2.push(`[TIMELINE:OFFLINE] ===== END LOG FILE ANALYSIS =====`);
    return lines2.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Stale Timeline Cleanup                                             */
  /* ------------------------------------------------------------------ */

  protected cleanupStaleTimelines(): void {
    const now = Date.now();
    for (const [, tl] of this.timelines) {
      if (tl.status !== TimelineStatus.Live) continue;
      if (now - tl.lastActivityAt > STALE_TIMELINE_TIMEOUT_MS) {
        tl.endTime = now;
        tl.durationMs = now - tl.startTime;
        tl.status = TimelineStatus.TimedOut;
        tl.error = `No activity for ${STALE_TIMELINE_TIMEOUT_MS}ms`;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.staleTimer);
    this.subscription.dispose();
    this.timelines.clear();
    this.timelineOrder.length = 0;
    this.eventsByTraceId.clear();
    this.traceOrder.length = 0;
    this.totalCreated = 0;
    this.totalReconstructionTimeMs = 0;
    this.reconstructionCount = 0;
  }
}

/** Create a TimelineGenerator attached to the given reporter */
export function createTimelineGenerator(reporter: TelemetryReporter): TimelineGenerator {
  return new TimelineGenerator(reporter);
}
