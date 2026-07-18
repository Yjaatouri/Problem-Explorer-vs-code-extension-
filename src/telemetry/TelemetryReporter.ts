import { TelemetryBus, getTelemetryBus, TelemetrySubscription } from './TelemetryBus';
import { TelemetryEvent, TraceId, TelemetryConfigManager, now, generateCorrelationId, generateTraceId } from './TelemetryConfig';
import { getCurrentParentTraceId } from './TraceContext';

/** Interface for telemetry reporters */
export interface TelemetryReporter {
  /** Report an event if telemetry is enabled */
  report(event: TelemetryEvent): void;
  /** Report an event with generated trace ID and correlation ID */
  reportWithTrace(event: Omit<TelemetryEvent, 'traceId' | 'parentTraceId' | 'correlationId' | 'timestamp'>): void;
  /** Subscribe to telemetry events */
  subscribe(eventType: string, listener: (event: TelemetryEvent) => void): TelemetrySubscription;
  /** Subscribe to all telemetry events */
  subscribeAll(listener: (event: TelemetryEvent) => void): TelemetrySubscription;
  /** Flush any buffered events (no-op for this implementation) */
  flush(): void;
  /** Dispose the reporter */
  dispose(): void;
}

/** Create a telemetry event with automatic trace context */
export function createEvent(
  type: string,
  source?: string,
  traceId?: TraceId,
  parentTraceId?: TraceId
): Omit<TelemetryEvent, 'correlationId' | 'timestamp'> {
  return {
    type,
    traceId: traceId ?? generateTraceId(),
    parentTraceId: parentTraceId ?? getCurrentParentTraceId(),
    source,
  };
}

/** Reporter that publishes to the telemetry bus when enabled, no-op when disabled */
export class BusTelemetryReporter implements TelemetryReporter {
  private enabled: boolean;
  private readonly bus: TelemetryBus;

  constructor(configManager: TelemetryConfigManager, bus?: TelemetryBus) {
    this.enabled = configManager.isEnabled();
    this.bus = bus ?? getTelemetryBus();
    configManager.onDidChangeConfig((config) => {
      this.enabled = config.enabled;
      this.bus.setEnabled(config.enabled);
    });
  }

  report(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.bus.publish({ ...event, timestamp: event.timestamp ?? now() });
  }

  reportWithTrace(event: Omit<TelemetryEvent, 'traceId' | 'parentTraceId' | 'correlationId' | 'timestamp'>): void {
    if (!this.enabled) return;
    const traceId = generateTraceId();
    const parentTraceId = getCurrentParentTraceId();
    this.bus.publish({
      ...event,
      traceId,
      parentTraceId,
      timestamp: now(),
      correlationId: generateCorrelationId(),
    });
  }

  subscribe(eventType: string, listener: (event: TelemetryEvent) => void): TelemetrySubscription {
    return this.bus.subscribe(eventType, listener);
  }

  subscribeAll(listener: (event: TelemetryEvent) => void): TelemetrySubscription {
    return this.bus.subscribeAll(listener);
  }

  flush(): void {
    // No buffering in this implementation - events are published immediately
  }

  dispose(): void {
    // Bus is managed separately
  }
}

/** No-op reporter returned when telemetry is disabled (near-zero overhead) */
export class NoopTelemetryReporter implements TelemetryReporter {
  report(): void {}
  reportWithTrace(): void {}
  subscribe(): TelemetrySubscription {
    return { eventType: '', dispose: () => {} };
  }
  subscribeAll(): TelemetrySubscription {
    return { eventType: '*', dispose: () => {} };
  }
  flush(): void {}
  dispose(): void {}
}

/** Factory to create the appropriate reporter based on config */
export function createTelemetryReporter(configManager: TelemetryConfigManager): TelemetryReporter {
  if (configManager.isEnabled()) {
    return new BusTelemetryReporter(configManager);
  }
  return new NoopTelemetryReporter();
}