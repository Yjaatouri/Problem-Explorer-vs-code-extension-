import { DiagnosticProviderManager, ProviderState } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ScanProgress } from '../../core/types';
import { TelemetryReporter } from '../../telemetry';
import { generateTraceId } from '../../telemetry';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

/** Structured event payload for provider lifecycle events */
export interface ProviderLifecycleEvent {
  readonly type: 'provider.lifecycle';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'ProviderMonitor';
  readonly provider: string;
  readonly phase: 'initialize' | 'start' | 'stop' | 'dispose';
  readonly oldState: ProviderState | undefined;
  readonly newState: ProviderState;
  readonly executionTimeMs: number;
  readonly success: boolean;
  readonly error?: string;
}

/** Structured event payload for provider refresh events */
export interface ProviderRefreshEvent {
  readonly type: 'provider.refresh';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'ProviderMonitor';
  readonly provider: string;
  readonly phase: 'begin' | 'end' | 'cancelled';
  readonly executionTimeMs: number;
  readonly success?: boolean;
  readonly error?: string;
}

/** Structured event payload for provider scan result events */
export interface ProviderScanResultEvent {
  readonly type: 'provider.scanResult';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'ProviderMonitor';
  readonly provider: string;
  readonly uriCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for provider error events */
export interface ProviderErrorEvent {
  readonly type: 'provider.error';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'ProviderMonitor';
  readonly provider: string;
  readonly phase: 'refresh' | 'initialize' | 'start' | 'stop' | 'dispose' | 'unknown';
  readonly error: string;
  readonly executionTimeMs: number;
}

/** Structured event payload for provider registry events */
export interface ProviderRegistryEvent {
  readonly type: 'provider.registry';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'ProviderMonitor';
  readonly provider: string;
  readonly action: 'registered' | 'unregistered';
  readonly capabilities?: readonly string[];
  readonly priority?: number;
}

/** Structured event payload for provider assertion failure events */
export interface ProviderAssertionEvent {
  readonly type: 'provider.assertion';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'ProviderMonitor';
  readonly provider: string;
  readonly assertion: string;
  readonly detail: string;
}

/** Union of all provider monitor event types */
export type ProviderTelemetryEvent =
  | ProviderLifecycleEvent
  | ProviderRefreshEvent
  | ProviderScanResultEvent
  | ProviderErrorEvent
  | ProviderRegistryEvent
  | ProviderAssertionEvent;

/* ------------------------------------------------------------------ */
/*  Statistics & snapshot interfaces                                   */
/* ------------------------------------------------------------------ */

/** Cumulative refresh statistics for a single provider */
export interface ProviderStatistics {
  totalRefreshes: number;
  successfulRefreshes: number;
  failedRefreshes: number;
  cancelledRefreshes: number;
  totalRefreshDurationMs: number;
  averageRefreshDurationMs: number;
  longestRefreshDurationMs: number;
  shortestRefreshDurationMs: number;
  totalDiagnosticsProduced: number;
  totalUrisProcessed: number;
  totalScans: number;
  lastRefreshTimestamp: number;
  lastRefreshDurationMs: number;
}

/** Point-in-time snapshot of a single provider's monitored state */
export interface ProviderSnapshot {
  name: string;
  state: ProviderState;
  scanning: boolean;
  activeRefreshCount: number;
  lastRefreshTimestamp: number;
  lastRefreshDurationMs: number;
  lastError: string | undefined;
  statistics: ProviderStatistics;
}

/* ------------------------------------------------------------------ */
/*  Internal tracking state per provider                               */
/* ------------------------------------------------------------------ */

interface ProviderTrackingState {
  originalRefresh: DiagnosticProvider['refresh'];
  state: ProviderState;
  scanning: boolean;
  activeRefreshCount: number;
  refreshStartTime: number;
  refreshTimestamps: number[];
  lastRefreshDurationMs: number;
  lastRefreshTimestamp: number;
  lastError: string | undefined;

  /* assertions */
  disposed: boolean;

  /* statistics */
  totalRefreshes: number;
  successfulRefreshes: number;
  failedRefreshes: number;
  cancelledRefreshes: number;
  totalRefreshDurationMs: number;
  longestRefreshDurationMs: number;
  shortestRefreshDurationMs: number;
  totalDiagnosticsProduced: number;
  totalUrisProcessed: number;
  totalScans: number;

  /* lifecycle timing */
  registrationTime: number;
  initializeStartTime: number;
  startTime: number;
  stopTime: number;
}

/* ------------------------------------------------------------------ */
/*  ProviderMonitor                                                     */
/* ------------------------------------------------------------------ */

/** Monitors DiagnosticProvider lifecycle, refresh, scan results, errors, and performance */
export class ProviderMonitor {
  private readonly providers = new Map<string, ProviderTrackingState>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private disposed = false;

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly reporter: TelemetryReporter
  ) {
    /* Attach to already-registered providers */
    for (const info of this.manager.all()) {
      this.onProviderRegistered(info.name, info.provider);
    }

    /* Subscribe to future registrations and unregistrations */
    this.subscriptions.push(this.manager.onDidRegister((info) => {
      if (this.disposed) return;
      this.onProviderRegistered(info.name, info.provider);
      this.emit({
        type: 'provider.registry',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'ProviderMonitor',
        provider: info.name,
        action: 'registered',
        capabilities: info.metadata.capabilities,
        priority: info.metadata.priority,
      });
    }));

    this.subscriptions.push(this.manager.onDidUnregister(({ name }) => {
      if (this.disposed) return;
      this.emit({
        type: 'provider.registry',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'ProviderMonitor',
        provider: name,
        action: 'unregistered',
      });
      this.onProviderUnregistered(name);
    }));

    /* Subscribe to state changes from the manager */
    this.subscriptions.push(this.manager.onDidChangeProviderState(({ name, oldState, newState }) => {
      if (this.disposed) return;
      this.handleStateChange(name, oldState, newState);
    }));

    /* Subscribe to scan progress events */
    this.subscriptions.push(this.manager.onDidScanProgress((progress: ScanProgress) => {
      if (this.disposed) return;
      this.handleScanProgress(progress);
    }));
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** Get cumulative statistics for a named provider */
  getStatistics(name: string): ProviderStatistics | undefined {
    const t = this.providers.get(name);
    if (!t) return undefined;
    return this.toStatistics(t);
  }

  /** Get statistics for all monitored providers */
  getAllStatistics(): Map<string, ProviderStatistics> {
    const result = new Map<string, ProviderStatistics>();
    for (const [name, t] of this.providers) {
      result.set(name, this.toStatistics(t));
    }
    return result;
  }

  /** Get a point-in-time snapshot for a named provider */
  getSnapshot(name: string): ProviderSnapshot | undefined {
    const t = this.providers.get(name);
    if (!t) return undefined;
    return {
      name,
      state: t.state,
      scanning: t.scanning,
      activeRefreshCount: t.activeRefreshCount,
      lastRefreshTimestamp: t.lastRefreshTimestamp,
      lastRefreshDurationMs: t.lastRefreshDurationMs,
      lastError: t.lastError,
      statistics: this.toStatistics(t),
    };
  }

  /** Get snapshots for all monitored providers */
  getAllSnapshots(): ProviderSnapshot[] {
    const result: ProviderSnapshot[] = [];
    for (const [name, t] of this.providers) {
      result.push({
        name,
        state: t.state,
        scanning: t.scanning,
        activeRefreshCount: t.activeRefreshCount,
        lastRefreshTimestamp: t.lastRefreshTimestamp,
        lastRefreshDurationMs: t.lastRefreshDurationMs,
        lastError: t.lastError,
        statistics: this.toStatistics(t),
      });
    }
    return result;
  }

  /** Dispose the monitor, restoring all wrapped methods */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    /* Restore original refresh methods on all providers */
    for (const [name, t] of this.providers) {
      const info = this.manager.getInfo(name);
      if (info) {
        info.provider.refresh = t.originalRefresh;
      }
    }

    this.providers.clear();

    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Provider registration/unregistration                               */
  /* ------------------------------------------------------------------ */

  private onProviderRegistered(name: string, provider: DiagnosticProvider): void {
    if (this.providers.has(name)) return;

    const originalRefresh = provider.refresh.bind(provider);

    const tracking: ProviderTrackingState = {
      originalRefresh,
      state: ProviderState.idle,
      scanning: false,
      activeRefreshCount: 0,
      refreshStartTime: 0,
      refreshTimestamps: [],
      lastRefreshDurationMs: 0,
      lastRefreshTimestamp: 0,
      lastError: undefined,
      disposed: false,
      totalRefreshes: 0,
      successfulRefreshes: 0,
      failedRefreshes: 0,
      cancelledRefreshes: 0,
      totalRefreshDurationMs: 0,
      longestRefreshDurationMs: 0,
      shortestRefreshDurationMs: 0,
      totalDiagnosticsProduced: 0,
      totalUrisProcessed: 0,
      totalScans: 0,
      registrationTime: Date.now(),
      initializeStartTime: 0,
      startTime: 0,
      stopTime: 0,
    };

    this.providers.set(name, tracking);

    /* Subscribe to onDidUpdate for scan result tracking */
    this.subscriptions.push(provider.onDidUpdate((uris) => {
      if (this.disposed) return;
      this.handleProviderUpdate(name, uris);
    }));

    /* Wrap refresh() to capture start/end/duration/success/failure */
    const self = this;
    provider.refresh = function (): void | Promise<void> {
      return self.wrapRefresh(name, tracking, provider);
    };

    tracking.refreshTimestamps.push(Date.now());
  }

  private onProviderUnregistered(name: string): void {
    const t = this.providers.get(name);
    if (t) {
      /* Restore original refresh */
      const info = this.manager.getInfo(name);
      if (info) {
        info.provider.refresh = t.originalRefresh;
      }
    }
    this.providers.delete(name);
  }

  /* ------------------------------------------------------------------ */
  /*  Refresh wrapping                                                   */
  /* ------------------------------------------------------------------ */

  private async wrapRefresh(
    name: string,
    tracking: ProviderTrackingState,
    provider: DiagnosticProvider
  ): Promise<void> {
    if (this.disposed || tracking.disposed) {
      tracking.originalRefresh.call(provider);
      return;
    }

    tracking.activeRefreshCount++;
    tracking.scanning = true;
    const start = Date.now();
    const traceId = generateTraceId();

    this.emit({
      type: 'provider.refresh',
      timestamp: start,
      traceId,
      source: 'ProviderMonitor',
      provider: name,
      phase: 'begin',
      executionTimeMs: 0,
    });

    try {
      const result = tracking.originalRefresh.call(provider);

      if (result instanceof Promise) {
        await result;
      }

      const elapsed = Date.now() - start;
      tracking.totalRefreshes++;
      tracking.successfulRefreshes++;
      tracking.totalRefreshDurationMs += elapsed;
      tracking.lastRefreshDurationMs = elapsed;
      tracking.lastRefreshTimestamp = Date.now();

      if (elapsed > tracking.longestRefreshDurationMs) {
        tracking.longestRefreshDurationMs = elapsed;
      }
      if (tracking.shortestRefreshDurationMs === 0 || elapsed < tracking.shortestRefreshDurationMs) {
        tracking.shortestRefreshDurationMs = elapsed;
      }

      this.emit({
        type: 'provider.refresh',
        timestamp: Date.now(),
        traceId,
        source: 'ProviderMonitor',
        provider: name,
        phase: 'end',
        executionTimeMs: elapsed,
        success: true,
      });
    } catch (err) {
      const elapsed = Date.now() - start;
      tracking.totalRefreshes++;
      tracking.failedRefreshes++;
      tracking.totalRefreshDurationMs += elapsed;
      tracking.lastRefreshDurationMs = elapsed;
      tracking.lastRefreshTimestamp = Date.now();
      tracking.lastError = err instanceof Error ? err.message : String(err);

      this.emit({
        type: 'provider.error',
        timestamp: Date.now(),
        traceId,
        source: 'ProviderMonitor',
        provider: name,
        phase: 'refresh',
        error: err instanceof Error ? err.message : String(err),
        executionTimeMs: elapsed,
      });

      this.emit({
        type: 'provider.refresh',
        timestamp: Date.now(),
        traceId,
        source: 'ProviderMonitor',
        provider: name,
        phase: 'end',
        executionTimeMs: elapsed,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tracking.activeRefreshCount--;
      tracking.scanning = tracking.activeRefreshCount > 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Scan progress handling                                             */
  /* ------------------------------------------------------------------ */

  private handleScanProgress(progress: ScanProgress): void {
    const t = this.providers.get(progress.providerName);
    if (!t) return;

    switch (progress.phase) {
      case 'cancelled':
        t.refreshTimestamps = t.refreshTimestamps.filter(ts => ts > Date.now() - 60000);
        t.totalRefreshes++;
        t.cancelledRefreshes++;
        this.emit({
          type: 'provider.refresh',
          timestamp: Date.now(),
          traceId: generateTraceId(),
          source: 'ProviderMonitor',
          provider: progress.providerName,
          phase: 'cancelled',
          executionTimeMs: t.refreshTimestamps.length > 0 ? Date.now() - t.refreshTimestamps[0] : 0,
        });
        break;
      case 'error':
        this.emit({
          type: 'provider.error',
          timestamp: Date.now(),
          traceId: generateTraceId(),
          source: 'ProviderMonitor',
          provider: progress.providerName,
          phase: 'refresh',
          error: progress.detail ?? progress.message ?? 'Unknown scan error',
          executionTimeMs: 0,
        });
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Provider update handling                                           */
  /* ------------------------------------------------------------------ */

  private handleProviderUpdate(name: string, uris: readonly any[]): void {
    const t = this.providers.get(name);
    if (!t) return;

    const info = this.manager.getInfo(name);
    if (!info) return;

    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const uri of uris) {
      const state = info.provider.store.get(uri);
      if (state) {
        errors += state.errorCount;
        warnings += state.warningCount;
        infos += state.infoCount;
      }
    }

    t.totalDiagnosticsProduced += errors + warnings + infos;
    t.totalUrisProcessed += uris.length;
    t.totalScans++;

    const elapsed = t.lastRefreshDurationMs > 0 ? t.lastRefreshDurationMs : 0;

    this.emit({
      type: 'provider.scanResult',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'ProviderMonitor',
      provider: name,
      uriCount: uris.length,
      errorCount: errors,
      warningCount: warnings,
      infoCount: infos,
      executionTimeMs: elapsed,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  State change handling                                              */
  /* ------------------------------------------------------------------ */

  private handleStateChange(name: string, oldState: ProviderState, newState: ProviderState): void {
    const t = this.providers.get(name);
    if (!t) return;

    t.state = newState;
    const now = Date.now();
    const traceId = generateTraceId();

    /* Compute duration for the completed phase */
    let executionTimeMs = 0;

    if (newState === ProviderState.initializing) {
      t.initializeStartTime = now;
    }
    if (newState === ProviderState.running) {
      executionTimeMs = t.initializeStartTime > 0 ? now - t.initializeStartTime : 0;
      t.startTime = now;
    }
    if (oldState === ProviderState.running && newState === ProviderState.idle) {
      executionTimeMs = t.startTime > 0 ? now - t.startTime : 0;
      t.stopTime = now;
    }
    if (newState === ProviderState.disposed) {
      executionTimeMs = t.registrationTime > 0 ? now - t.registrationTime : 0;
    }

    const phase: 'initialize' | 'start' | 'stop' | 'dispose' | undefined =
      newState === ProviderState.initializing ? 'initialize' :
      newState === ProviderState.running ? 'start' :
      newState === ProviderState.disposed ? 'dispose' :
      oldState === ProviderState.running && newState === ProviderState.idle ? 'stop' :
      undefined;

    if (!phase) {
      if (newState === ProviderState.error) {
        this.emit({
          type: 'provider.error',
          timestamp: now,
          traceId,
          source: 'ProviderMonitor',
          provider: name,
          phase: 'unknown',
          error: `Provider entered error state`,
          executionTimeMs: now - (t.initializeStartTime || now),
        });
      }
      return;
    }

    if (newState === ProviderState.disposed) {
      t.disposed = true;
    }

    this.emit({
      type: 'provider.lifecycle',
      timestamp: now,
      traceId,
      source: 'ProviderMonitor',
      provider: name,
      phase,
      oldState,
      newState,
      executionTimeMs,
      success: newState !== ProviderState.error,
      error: newState === ProviderState.error ? `Provider entered error state after ${phase}` : undefined,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private toStatistics(t: ProviderTrackingState): ProviderStatistics {
    return {
      totalRefreshes: t.totalRefreshes,
      successfulRefreshes: t.successfulRefreshes,
      failedRefreshes: t.failedRefreshes,
      cancelledRefreshes: t.cancelledRefreshes,
      totalRefreshDurationMs: t.totalRefreshDurationMs,
      averageRefreshDurationMs: t.totalRefreshes > 0 ? Math.round(t.totalRefreshDurationMs / t.totalRefreshes) : 0,
      longestRefreshDurationMs: t.longestRefreshDurationMs,
      shortestRefreshDurationMs: t.shortestRefreshDurationMs,
      totalDiagnosticsProduced: t.totalDiagnosticsProduced,
      totalUrisProcessed: t.totalUrisProcessed,
      totalScans: t.totalScans,
      lastRefreshTimestamp: t.lastRefreshTimestamp,
      lastRefreshDurationMs: t.lastRefreshDurationMs,
    };
  }

  private emit(event: ProviderTelemetryEvent): void {
    try {
      this.reporter.report(event as any);
    } catch {
      /* ProviderMonitor must never crash the extension */
    }
  }
}

/** Create a ProviderMonitor attached to the given manager and reporter */
export function createProviderMonitor(
  manager: DiagnosticProviderManager,
  reporter: TelemetryReporter
): ProviderMonitor {
  return new ProviderMonitor(manager, reporter);
}
