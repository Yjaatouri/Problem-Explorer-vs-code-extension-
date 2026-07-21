import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/** Metadata stored per tracked timer */
interface TimerInfo {
  delay: number;
  createdAt: number;
}

/** Structured event payload for setTimeout */
export interface TimerSetTimeoutEventData {
  readonly type: 'timer.setTimeout';
  readonly delay: number;
}

/** Structured event payload for clearTimeout */
export interface TimerClearTimeoutEventData {
  readonly type: 'timer.clearTimeout';
  readonly actualDelay: number;
}

/** Structured event payload for timer callback execution */
export interface TimerExecutedEventData {
  readonly type: 'timer.executed';
  readonly actualDelay: number;
  readonly callbackDuration: number;
}

/** Union of all timer monitor event types */
export type TimerMonitorEvent =
  | TimerSetTimeoutEventData
  | TimerClearTimeoutEventData
  | TimerExecutedEventData;

/** Monitors all setTimeout/clearTimeout calls by wrapping globals */
export class TimerMonitor {
  private readonly originalSetTimeout: typeof globalThis.setTimeout;
  private readonly originalClearTimeout: typeof globalThis.clearTimeout;
  private readonly timers = new Map<NodeJS.Timeout, TimerInfo>();
  private disposed = false;

  constructor(private readonly reporter: TelemetryReporter) {
    this.originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    this.originalClearTimeout = globalThis.clearTimeout.bind(globalThis);

    globalThis.setTimeout = (<TArgs extends any[]>(
      callback: (...args: TArgs) => void,
      ms?: number,
      ...args: TArgs
    ): NodeJS.Timeout => {
      if (this.disposed) {
        return this.originalSetTimeout(callback, ms, ...args) as NodeJS.Timeout;
      }

      const delay = ms ?? 0;
      const start = Date.now();

      const { originalSetTimeout, timers, reporter, reportExecution } = this;
      const timerId = originalSetTimeout(
        function (this: unknown) {
          const actualDelay = Date.now() - start;
          const cbStart = Date.now();
          try {
            callback.apply(this, args);
          } finally {
            const cbDuration = Date.now() - cbStart;
            reportExecution(actualDelay, cbDuration);
            if (timerId) timers.delete(timerId);
          }
        },
        delay,
      ) as NodeJS.Timeout;

      timers.set(timerId, { delay, createdAt: start });

      reporter.report({
        type: 'timer.setTimeout',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'TimerMonitor',
        delay,
      } as any);

      return timerId;
    }) as typeof globalThis.setTimeout;

    globalThis.clearTimeout = ((timerId: NodeJS.Timeout | number | string | undefined): void => {
      if (this.disposed) {
        return this.originalClearTimeout(timerId);
      }

      const info = timerId !== undefined ? this.timers.get(timerId as NodeJS.Timeout) : undefined;
      if (info) {
        this.reporter.report({
          type: 'timer.clearTimeout',
          timestamp: Date.now(),
          traceId: generateTraceId(),
          source: 'TimerMonitor',
          actualDelay: Date.now() - info.createdAt,
        } as any);
        this.timers.delete(timerId as NodeJS.Timeout);
      }

      this.originalClearTimeout(timerId);
    }) as typeof globalThis.clearTimeout;
  }

  private reportExecution(actualDelay: number, callbackDuration: number): void {
    this.reporter.report({
      type: 'timer.executed',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'TimerMonitor',
      actualDelay,
      callbackDuration,
    } as any);
  }

  /** Restore original timer functions */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    globalThis.setTimeout = this.originalSetTimeout;
    globalThis.clearTimeout = this.originalClearTimeout;
    this.timers.clear();
  }
}

/** Create a TimerMonitor that wraps global timer functions */
export function createTimerMonitor(
  reporter: TelemetryReporter
): TimerMonitor {
  return new TimerMonitor(reporter);
}