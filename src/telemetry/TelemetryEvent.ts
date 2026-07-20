/** Unique identifier for a single execution trace */
export type TraceId = string & { readonly __brand: typeof TraceIdBrand };
declare const TraceIdBrand: unique symbol;

/** Generate a new trace ID */
export function generateTraceId(): TraceId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` as TraceId;
}

/** Generate a correlation ID for grouping related events */
export function generateCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create a timestamp for events */
export function now(): number {
  return Date.now();
}

/** Base interface for all telemetry events */
export interface TelemetryEvent {
  /** Unique event type identifier, e.g., 'store.set', 'scanner.start', 'decoration.provide' */
  readonly type: string;
  /** Monotonic timestamp in milliseconds since epoch */
  readonly timestamp: number;
  /** Unique identifier for this execution trace */
  readonly traceId: TraceId;
  /** Optional parent trace ID for nested operations */
  readonly parentTraceId?: TraceId;
  /** Optional correlation ID to group related events across components */
  readonly correlationId?: string;
  /** Optional source component name for filtering */
  readonly source?: string;
}

/** Type guard for telemetry events */
export function isTelemetryEvent(obj: unknown): obj is TelemetryEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    typeof (obj as Record<string, unknown>).type === 'string' &&
    'timestamp' in obj &&
    typeof (obj as Record<string, unknown>).timestamp === 'number' &&
    'traceId' in obj &&
    typeof (obj as Record<string, unknown>).traceId === 'string'
  );
}