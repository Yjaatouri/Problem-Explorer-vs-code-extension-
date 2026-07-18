import { ConfigurationChangeEvent, Event, EventEmitter, workspace } from 'vscode';
import { TelemetryEvent, isTelemetryEvent, TraceId, now, generateCorrelationId, generateTraceId } from './TelemetryEvent';

/** Configuration shape for the telemetry system */
export interface TelemetryConfig {
  /** Master switch - when false, all telemetry overhead is near-zero */
  readonly enabled: boolean;
  /** Maximum events to buffer in memory before flushing */
  readonly bufferSize: number;
  /** Interval in ms to flush buffered events */
  readonly flushIntervalMs: number;
  /** Whether to include stack traces in error events */
  readonly includeStackTraces: boolean;
}

/** Default telemetry configuration */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: false,
  bufferSize: 1000,
  flushIntervalMs: 5000,
  includeStackTraces: false,
};

/** Settings keys for telemetry configuration */
export const TELEMETRY_SETTINGS = {
  ENABLED: 'telemetry.enabled',
  BUFFER_SIZE: 'telemetry.bufferSize',
  FLUSH_INTERVAL_MS: 'telemetry.flushIntervalMs',
  INCLUDE_STACK_TRACES: 'telemetry.includeStackTraces',
} as const;

/** Abstraction over VS Code configuration for testability */
export interface TelemetryConfigDelegate {
  getConfiguration(section?: string): {
    get<T>(key: string, defaultValue?: T): T;
  };
  onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
}

const defaultDelegate: TelemetryConfigDelegate = {
  getConfiguration: (section) => workspace.getConfiguration(section),
  onDidChangeConfiguration: workspace.onDidChangeConfiguration,
};

/** Reads and watches telemetry settings from VS Code configuration */
export class TelemetryConfigManager {
  private delegate: TelemetryConfigDelegate;
  private config: TelemetryConfig;
  private readonly _onDidChangeConfig = new EventEmitter<TelemetryConfig>();
  readonly onDidChangeConfig: Event<TelemetryConfig> = this._onDidChangeConfig.event;

  constructor(delegate?: TelemetryConfigDelegate) {
    this.delegate = delegate ?? defaultDelegate;
    this.config = this.readConfig();
    this.delegate.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('problemExplorer.telemetry')) {
        this.config = this.readConfig();
        this._onDidChangeConfig.fire(this.config);
      }
    });
  }

  /** Get current telemetry configuration snapshot */
  getConfig(): TelemetryConfig {
    return this.config;
  }

  /** Check if telemetry is currently enabled (fast path, no allocation) */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  private readConfig(): TelemetryConfig {
    const cfg = this.delegate.getConfiguration('problemExplorer');
    return {
      enabled: cfg.get<boolean>(TELEMETRY_SETTINGS.ENABLED, DEFAULT_TELEMETRY_CONFIG.enabled),
      bufferSize: cfg.get<number>(TELEMETRY_SETTINGS.BUFFER_SIZE, DEFAULT_TELEMETRY_CONFIG.bufferSize),
      flushIntervalMs: cfg.get<number>(TELEMETRY_SETTINGS.FLUSH_INTERVAL_MS, DEFAULT_TELEMETRY_CONFIG.flushIntervalMs),
      includeStackTraces: cfg.get<boolean>(TELEMETRY_SETTINGS.INCLUDE_STACK_TRACES, DEFAULT_TELEMETRY_CONFIG.includeStackTraces),
    };
  }
}

/** Re-export for convenience */
export { TelemetryEvent, isTelemetryEvent, TraceId, now, generateCorrelationId, generateTraceId };