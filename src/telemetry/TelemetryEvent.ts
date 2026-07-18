/** Base interface for all telemetry events */
export interface TelemetryEvent {
  /** Unique event type identifier, e.g., 'store.set', 'scanner.start', 'decoration.provide' */
  readonly type: string;
  /** Monotonic timestamp in milliseconds since epoch */
  readonly timestamp: number;
  /** Optional correlation ID to trace related events across components */
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
    typeof (obj as Record<string, unknown>).timestamp === 'number'
  );
}