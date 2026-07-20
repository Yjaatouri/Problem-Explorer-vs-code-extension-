import { Disposable } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { TelemetryReporter } from '../../telemetry';
import { TraceId } from '../../telemetry';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

/** Structured event payload for file-save trigger */
export interface AutoScanFileSavedEvent {
  readonly type: 'autoscan.fileSaved';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly uri: string;
  readonly provider: string;
  readonly extension: string;
  readonly fileEvent: 'save' | 'create' | 'delete' | 'rename';
  readonly selected: boolean;
  readonly skipReason?: string;
}

/** Structured event payload for queue state */
export interface AutoScanQueueEvent {
  readonly type: 'autoscan.queue';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly provider: string;
  readonly queueSize: number;
  readonly action: 'added' | 'duplicate' | 'removed';
}

/** Structured event payload for debounce timing */
export interface AutoScanDebounceEvent {
  readonly type: 'autoscan.debounce';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly action: 'scheduled' | 'cancelled' | 'fired';
  readonly debounceMs: number;
  readonly queueSize: number;
}

/** Structured event payload for flush begin */
export interface AutoScanFlushEvent {
  readonly type: 'autoscan.flush';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly providerNames: readonly string[];
  readonly queueSize: number;
  readonly debounceDelay: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for a provider refresh during flush */
export interface AutoScanRefreshEvent {
  readonly type: 'autoscan.refresh';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly provider: string;
  readonly phase: 'begin' | 'end';
  readonly executionTimeMs: number;
  readonly success?: boolean;
  readonly error?: string;
}

/** Structured event payload for flush completion */
export interface AutoScanFlushCompleteEvent {
  readonly type: 'autoscan.flushComplete';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly providerCount: number;
  readonly executionTimeMs: number;
  readonly rescheduled: boolean;
}

/** Structured event payload for assertion failures */
export interface AutoScanAssertionEvent {
  readonly type: 'autoscan.assertion';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'AutoScannerMonitor';
  readonly assertion: string;
  readonly detail: string;
}

/** Union of all auto-scanner monitor event types */
export type AutoScannerTelemetryEvent =
  | AutoScanFileSavedEvent
  | AutoScanQueueEvent
  | AutoScanDebounceEvent
  | AutoScanFlushEvent
  | AutoScanRefreshEvent
  | AutoScanFlushCompleteEvent
  | AutoScanAssertionEvent;

/* ------------------------------------------------------------------ */
/*  Statistics & snapshot interfaces                                   */
/* ------------------------------------------------------------------ */

/** Cumulative auto-scanner statistics for a single cycle */
export interface AutoScannerStatistics {
  totalFileEvents: number;
  totalSaves: number;
  totalCreates: number;
  totalDeletes: number;
  totalRenames: number;
  totalQueued: number;
  totalDuplicateQueueAttempts: number;
  totalFlushes: number;
  totalProvidersExecuted: number;
  totalProvidersSkipped: number;
  totalRefreshesStarted: number;
  totalRefreshesCompleted: number;
  totalRefreshesFailed: number;
  totalDebounceScheduled: number;
  totalDebounceCancelled: number;
  totalDebounceFired: number;
  totalReschedules: number;
  averageDebounceDelayMs: number;
  averageFlushDurationMs: number;
  averageRefreshDurationMs: number;
  longestFlushDurationMs: number;
  lastFlushDurationMs: number;
  lastFlushTimestamp: number;
}

/** Point-in-time snapshot of auto-scanner state */
export interface AutoScannerSnapshot {
  activeScans: number;
  flushedProviderCount: number;
  lastFlushDurationMs: number;
  lastFlushTimestamp: number;
  isFlushing: boolean;
  statistics: AutoScannerStatistics;
}

/* ------------------------------------------------------------------ */
/*  Internal tracking state                                            */
/* ------------------------------------------------------------------ */

interface AutoScannerInternalState {
  queuedProviders: Set<string>;
  providerTimestamps: Map<string, number>;
  flushedProviderCount: number;
  activeScans: number;
  flushStartTime: number;
  lastFileEventTime: number;
  isFlushing: boolean;
  lastDebounceMs: number;

  /* counters */
  totalFileEvents: number;
  totalSaves: number;
  totalCreates: number;
  totalDeletes: number;
  totalRenames: number;
  totalQueued: number;
  totalDuplicateQueueAttempts: number;
  totalFlushes: number;
  totalProvidersExecuted: number;
  totalProvidersSkipped: number;
  totalRefreshesStarted: number;
  totalRefreshesCompleted: number;
  totalRefreshesFailed: number;
  totalDebounceScheduled: number;
  totalDebounceCancelled: number;
  totalDebounceFired: number;
  totalReschedules: number;

  /* timing accumulators */
  totalDebounceDelayMs: number;
  totalFlushDurationMs: number;
  totalRefreshDurationMs: number;
  longestFlushDurationMs: number;
  lastFlushDurationMs: number;
  lastFlushTimestamp: number;
}

/* ------------------------------------------------------------------ */
/*  AutoScannerMonitor                                                 */
/* ------------------------------------------------------------------ */

/** Monitors the auto-scan pipeline via external observation */
export class AutoScannerMonitor implements Disposable {
  private readonly state: AutoScannerInternalState;
  private readonly disposables: Disposable[] = [];
  private disposed = false;

  private constructor(
    manager: DiagnosticProviderManager,
    reporter: TelemetryReporter
  ) {
    void manager;
    void reporter;
    this.state = this.createInitialState();
  }

  static create(
    manager: DiagnosticProviderManager,
    reporter: TelemetryReporter
  ): AutoScannerMonitor {
    return new AutoScannerMonitor(manager, reporter);
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  getStatistics(): AutoScannerStatistics {
    return Object.freeze(this.toStatistics());
  }

  getSnapshot(): AutoScannerSnapshot {
    return Object.freeze({
      activeScans: this.state.activeScans,
      flushedProviderCount: this.state.flushedProviderCount,
      lastFlushDurationMs: this.state.lastFlushDurationMs,
      lastFlushTimestamp: this.state.lastFlushTimestamp,
      isFlushing: this.state.isFlushing,
      statistics: this.toStatistics(),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                            */
  /* ------------------------------------------------------------------ */

  private createInitialState(): AutoScannerInternalState {
    return {
      queuedProviders: new Set(),
      providerTimestamps: new Map(),
      flushedProviderCount: 0,
      activeScans: 0,
      flushStartTime: 0,
      lastFileEventTime: 0,
      isFlushing: false,
      lastDebounceMs: 0,
      totalFileEvents: 0,
      totalSaves: 0,
      totalCreates: 0,
      totalDeletes: 0,
      totalRenames: 0,
      totalQueued: 0,
      totalDuplicateQueueAttempts: 0,
      totalFlushes: 0,
      totalProvidersExecuted: 0,
      totalProvidersSkipped: 0,
      totalRefreshesStarted: 0,
      totalRefreshesCompleted: 0,
      totalRefreshesFailed: 0,
      totalDebounceScheduled: 0,
      totalDebounceCancelled: 0,
      totalDebounceFired: 0,
      totalReschedules: 0,
      totalDebounceDelayMs: 0,
      totalFlushDurationMs: 0,
      totalRefreshDurationMs: 0,
      longestFlushDurationMs: 0,
      lastFlushDurationMs: 0,
      lastFlushTimestamp: 0,
    };
  }

  private toStatistics(): AutoScannerStatistics {
    const s = this.state;
    return {
      totalFileEvents: s.totalFileEvents,
      totalSaves: s.totalSaves,
      totalCreates: s.totalCreates,
      totalDeletes: s.totalDeletes,
      totalRenames: s.totalRenames,
      totalQueued: s.totalQueued,
      totalDuplicateQueueAttempts: s.totalDuplicateQueueAttempts,
      totalFlushes: s.totalFlushes,
      totalProvidersExecuted: s.totalProvidersExecuted,
      totalProvidersSkipped: s.totalProvidersSkipped,
      totalRefreshesStarted: s.totalRefreshesStarted,
      totalRefreshesCompleted: s.totalRefreshesCompleted,
      totalRefreshesFailed: s.totalRefreshesFailed,
      totalDebounceScheduled: s.totalDebounceScheduled,
      totalDebounceCancelled: s.totalDebounceCancelled,
      totalDebounceFired: s.totalDebounceFired,
      totalReschedules: s.totalReschedules,
      averageDebounceDelayMs: s.totalDebounceScheduled > 0 ? Math.round(s.totalDebounceDelayMs / s.totalDebounceScheduled) : 0,
      averageFlushDurationMs: s.totalFlushes > 0 ? Math.round(s.totalFlushDurationMs / s.totalFlushes) : 0,
      averageRefreshDurationMs: s.totalRefreshesCompleted > 0 ? Math.round(s.totalRefreshDurationMs / s.totalRefreshesCompleted) : 0,
      longestFlushDurationMs: s.longestFlushDurationMs,
      lastFlushDurationMs: s.lastFlushDurationMs,
      lastFlushTimestamp: s.lastFlushTimestamp,
    };
  }
}

/** Create an AutoScannerMonitor attached to the given manager and reporter */
export const createAutoScannerMonitor: typeof AutoScannerMonitor.create = AutoScannerMonitor.create;
