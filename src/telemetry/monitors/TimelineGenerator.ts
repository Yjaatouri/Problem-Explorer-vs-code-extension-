import * as fs from 'fs';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';

/** A single entry in the event timeline */
export interface TimelineEntry {
  readonly seq: number;
  readonly type: string;
  readonly source: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly phase?: string;
  readonly detail?: string;
}

/** Structured timeline report for a single traceId */
export interface TimelineReport {
  readonly traceId: string;
  readonly entries: readonly TimelineEntry[];
  readonly totalDurationMs: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly missingEvents: readonly string[];
}

const MAX_EVENTS_PER_TRACE = 500;
const MAX_TRACES = 1000;

/** Known pipeline sequences for missing-event detection */
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

/** Builds forensic-style execution timelines from traceId-grouped event histories */
export class TimelineGenerator {
  private readonly eventsByTraceId = new Map<string, TelemetryEvent[]>();
  private readonly traceOrder: string[] = [];
  private disposed = false;
  private subscription: TelemetrySubscription | undefined;

  constructor(reporter: TelemetryReporter) {
    this.subscription = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('pipeline.') || event.type.startsWith('perf.') || event.type.startsWith('timeline.')) return;

      let chain = this.eventsByTraceId.get(event.traceId);
      if (!chain) {
        chain = [];
        this.eventsByTraceId.set(event.traceId, chain);
        this.traceOrder.push(event.traceId);
        if (this.traceOrder.length > MAX_TRACES) {
          const oldest = this.traceOrder.shift()!;
          this.eventsByTraceId.delete(oldest);
        }
      }
      chain.push(event);
      if (chain.length > MAX_EVENTS_PER_TRACE) {
        chain.splice(0, chain.length - MAX_EVENTS_PER_TRACE);
      }
    });
  }

  /** Get all trace IDs currently stored */
  getTraceIds(): readonly string[] {
    return [...this.traceOrder];
  }

  /** Get raw events for a traceId */
  getEvents(traceId: string): readonly TelemetryEvent[] {
    return this.eventsByTraceId.get(traceId) ?? [];
  }

  /** Generate a structured timeline report for the given traceId */
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

  /** Generate a human-readable forensic report string */
  generateForensicReport(traceId: string): string {
    const report = this.generateReport(traceId);
    const lines: string[] = [];
    const now = new Date().toISOString();

    lines.push(`[TIMELINE:REPORT] ===== TIMELINE REPORT ====="`);
    lines.push(`[TIMELINE:REPORT] Generated: ${now}`);
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

  /** Generate a summary report from a JSONL log file for offline forensic analysis */
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
      const data = e as any;
      if (data.phase === 'error' || data.phase === 'cancelled' || e.type === 'assertion.failure') {
        errors.push(`${e.type}[${e.traceId}]: ${data.error ?? data.detail ?? data.message ?? ''}`);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription?.dispose();
    this.eventsByTraceId.clear();
    this.traceOrder.length = 0;
  }
}

/** Create a TimelineGenerator attached to the given reporter */
export function createTimelineGenerator(reporter: TelemetryReporter): TimelineGenerator {
  return new TimelineGenerator(reporter);
}