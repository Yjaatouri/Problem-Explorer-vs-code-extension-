import { Disposable, Event, EventEmitter } from 'vscode';
import { TelemetryEvent } from './TelemetryEvent';

/** Subscription handle for telemetry events */
export interface TelemetrySubscription extends Disposable {
  /** The event type this subscription listens to, or '*' for all events */
  readonly eventType: string;
}

/** Central telemetry event bus.
 * Monitors publish events here; reporters subscribe to receive them.
 * When telemetry is disabled, all operations are near-zero overhead no-ops.
 */
export class TelemetryBus implements Disposable {
  private enabled: boolean = false;
  private readonly emitter = new EventEmitter<TelemetryEvent>();
  private subscriberCount: number = 0;
  private _telemetryErrorCount: number = 0;

  /** Enable or disable the telemetry bus. When disabled, publish() is a no-op. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Check if telemetry is currently enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Publish a telemetry event. No-op when disabled or no subscribers. */
  publish(event: TelemetryEvent): void {
    if (!this.enabled || this.subscriberCount === 0) {
      return;
    }
    try {
      this.emitter.fire(event);
    } catch {
      this._telemetryErrorCount++;
    }
  }

  /** Subscribe to telemetry events of a specific type */
  subscribe(eventType: string, listener: (event: TelemetryEvent) => void): TelemetrySubscription {
    this.subscriberCount++;
    const disposable = this.emitter.event((e) => {
      if (e.type === eventType) {
        try {
          listener(e);
        } catch {
          this._telemetryErrorCount++;
        }
      }
    });
    return {
      eventType,
      dispose: () => {
        disposable.dispose();
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
      },
    };
  }

  /** Subscribe to all telemetry events */
  subscribeAll(listener: (event: TelemetryEvent) => void): TelemetrySubscription {
    this.subscriberCount++;
    const disposable = this.emitter.event((e) => {
      try {
        listener(e);
      } catch {
        this._telemetryErrorCount++;
      }
    });
    return {
      eventType: '*',
      dispose: () => {
        disposable.dispose();
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
      },
    };
  }

  /** Get the event stream for advanced consumers */
  get event(): Event<TelemetryEvent> {
    return this.emitter.event;
  }

  /** Get current subscriber count (for debugging) */
  getSubscriberCount(): number {
    return this.subscriberCount;
  }

  /** Number of errors caught in telemetry listeners since last reset */
  getTelemetryErrorCount(): number {
    return this._telemetryErrorCount;
  }

  /** Reset the telemetry error counter to zero */
  resetTelemetryErrorCount(): void {
    this._telemetryErrorCount = 0;
  }

  dispose(): void {
    this.emitter.dispose();
    this.subscriberCount = 0;
    this._telemetryErrorCount = 0;
  }
}

/** Singleton instance for global access */
let _busInstance: TelemetryBus | undefined;

/** Get the global telemetry bus instance (creates if needed) */
export function getTelemetryBus(): TelemetryBus {
  if (!_busInstance) {
    _busInstance = new TelemetryBus();
  }
  return _busInstance;
}

/** Set a custom bus instance (for testing) */
export function setTelemetryBus(bus: TelemetryBus): void {
  if (_busInstance) {
    _busInstance.dispose();
  }
  _busInstance = bus;
}

/** Reset the singleton (for testing) */
export function resetTelemetryBus(): void {
  if (_busInstance) {
    _busInstance.dispose();
    _busInstance = undefined;
  }
}