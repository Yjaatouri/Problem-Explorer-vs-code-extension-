import { Disposable, Uri, workspace, TextDocument } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { ScanProgress } from '../../core/types';
import { TelemetryReporter } from '../../telemetry';
import { TraceId, generateTraceId } from '../../telemetry';

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
  debounceStartTime: number;

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
    private readonly manager: DiagnosticProviderManager,
    private readonly reporter: TelemetryReporter
  ) {
    this.state = this.createInitialState();
    this.subscribeToFileEvents();
    this.manager.onDidScanProgress((progress: ScanProgress) => {
      if (this.disposed) return;
      this.handleScanProgress(progress);
    });
  }

  static create(
    manager: DiagnosticProviderManager,
    reporter: TelemetryReporter
  ): AutoScannerMonitor {
    return new AutoScannerMonitor(manager, reporter);
  }

  /* ------------------------------------------------------------------ */
  /*  Scan progress handling                                             */
  /* ------------------------------------------------------------------ */

  private handleScanProgress(progress: ScanProgress): void {
    const now = Date.now();

    switch (progress.phase) {
      case 'resolving':
      case 'scanning':
      case 'parsing':
      case 'writing': {
        const isFirstScan = this.state.activeScans === 0;

        /* Emit debounce 'fired' on first scan progress after a quiet period */
        if (isFirstScan) {
          const delay = this.state.lastFileEventTime > 0 ? now - this.state.lastFileEventTime : 0;
          this.state.totalDebounceFired++;
          this.state.lastDebounceMs = delay;
          this.state.totalDebounceDelayMs += delay;
          this.emit({
            type: 'autoscan.debounce',
            timestamp: now,
            traceId: generateTraceId(),
            source: 'AutoScannerMonitor',
            action: 'fired',
            debounceMs: delay,
            queueSize: this.state.queuedProviders.size,
          });

          /* Flush begins when debounce fires and providers are queued */
          if (this.state.queuedProviders.size > 0) {
            this.state.isFlushing = true;
            this.state.flushStartTime = now;
            this.state.totalFlushes++;
            const providerNames = Array.from(this.state.queuedProviders);
            this.state.flushedProviderCount = providerNames.length;
            this.emit({
              type: 'autoscan.flush',
              timestamp: now,
              traceId: generateTraceId(),
              source: 'AutoScannerMonitor',
              providerNames,
              queueSize: providerNames.length,
              debounceDelay: delay,
              executionTimeMs: 0,
            });

            /* Move queued providers into execution tracking */
            this.state.queuedProviders.clear();
          }
        }

        const isNewProvider = !this.state.providerTimestamps.has(progress.providerName);
        if (isNewProvider) {
          this.state.providerTimestamps.set(progress.providerName, now);
          this.state.activeScans++;
          this.state.totalRefreshesStarted++;
          this.state.totalProvidersExecuted++;
        }

        break;
      }

      case 'completed': {
        const execTime = now - (this.state.providerTimestamps.get(progress.providerName) ?? now);
        this.state.providerTimestamps.delete(progress.providerName);
        this.state.activeScans = Math.max(0, this.state.activeScans - 1);
        this.state.totalRefreshesCompleted++;
        this.state.totalRefreshDurationMs += execTime;
        this.emitRefreshEnd(progress.providerName, execTime, true);
        this.checkFlushEnd(now);
        break;
      }

      case 'cancelled': {
        const execTime = now - (this.state.providerTimestamps.get(progress.providerName) ?? now);
        this.state.providerTimestamps.delete(progress.providerName);
        this.state.activeScans = Math.max(0, this.state.activeScans - 1);
        this.state.totalRefreshesCompleted++;
        this.state.totalRefreshDurationMs += execTime;
        this.emitRefreshEnd(progress.providerName, execTime, true, 'cancelled');
        this.checkFlushEnd(now);
        break;
      }

      case 'error': {
        const execTime = now - (this.state.providerTimestamps.get(progress.providerName) ?? now);
        this.state.providerTimestamps.delete(progress.providerName);
        this.state.activeScans = Math.max(0, this.state.activeScans - 1);
        this.state.totalRefreshesCompleted++;
        this.state.totalRefreshDurationMs += execTime;
        this.state.totalRefreshesFailed++;
        this.emitRefreshEnd(progress.providerName, execTime, false, 'error');
        this.checkFlushEnd(now);
        break;
      }
    }
  }

  private emitRefreshEnd(provider: string, execTime: number, success: boolean, error?: string): void {
    this.emit({
      type: 'autoscan.refresh',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'AutoScannerMonitor',
      provider,
      phase: 'end',
      executionTimeMs: execTime,
      success,
      error,
    });
  }

  private checkFlushEnd(now: number): void {
    if (this.state.activeScans !== 0) return;

    /* Flush cycle complete */
    this.state.isFlushing = false;
    const flushDuration = now - this.state.flushStartTime;
    this.state.lastFlushDurationMs = flushDuration;
    this.state.lastFlushTimestamp = now;
    this.state.totalFlushDurationMs += flushDuration;
    if (flushDuration > this.state.longestFlushDurationMs) {
      this.state.longestFlushDurationMs = flushDuration;
    }

    const rescheduled = this.state.queuedProviders.size > 0;
    if (rescheduled) {
      this.state.totalReschedules++;
    }

    this.emit({
      type: 'autoscan.flushComplete',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'AutoScannerMonitor',
      providerCount: this.state.flushedProviderCount,
      executionTimeMs: flushDuration,
      rescheduled,
    });
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
  /*  File event monitoring                                              */
  /* ------------------------------------------------------------------ */

  private subscribeToFileEvents(): void {
    this.disposables.push(
      workspace.onDidSaveTextDocument((doc: TextDocument) => {
        if (this.disposed) return;
        this.handleFileEvent(doc.uri, 'save');
      }),
      workspace.onDidCreateFiles((e) => {
        if (this.disposed) return;
        for (const uri of e.files) {
          this.handleFileEvent(uri, 'create');
        }
      }),
      workspace.onDidDeleteFiles((e) => {
        if (this.disposed) return;
        for (const uri of e.files) {
          this.handleFileEvent(uri, 'delete');
        }
      }),
      workspace.onDidRenameFiles((e) => {
        if (this.disposed) return;
        for (const { newUri } of e.files) {
          this.handleFileEvent(newUri, 'rename');
        }
      }),
    );
  }

  private handleFileEvent(uri: Uri, eventType: 'save' | 'create' | 'delete' | 'rename'): void {
    this.state.totalFileEvents++;
    if (eventType === 'save') this.state.totalSaves++;
    else if (eventType === 'create') this.state.totalCreates++;
    else if (eventType === 'delete') this.state.totalDeletes++;
    else if (eventType === 'rename') this.state.totalRenames++;

    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));
    const ownerName = this.manager.getOwner(ext);

    const now = Date.now();
    this.state.lastFileEventTime = now;

    this.emit({
      type: 'autoscan.fileSaved',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'AutoScannerMonitor',
      uri: uri.toString(),
      provider: ownerName ?? 'none',
      extension: ext,
      fileEvent: eventType,
      selected: ownerName !== undefined,
      skipReason: ownerName ? undefined : 'no provider owns this extension',
    });

    if (!ownerName) return;

    /* Queue management — mirror the AutoScanController's queuedProviders set */
    const wasEmpty = this.state.queuedProviders.size === 0 && !this.state.isFlushing;

    if (this.state.queuedProviders.has(ownerName)) {
      this.state.totalDuplicateQueueAttempts++;
      this.emit({
        type: 'autoscan.queue',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'AutoScannerMonitor',
        provider: ownerName,
        queueSize: this.state.queuedProviders.size,
        action: 'duplicate',
      });
    } else {
      this.state.queuedProviders.add(ownerName);
      this.state.totalQueued++;
      this.emit({
        type: 'autoscan.queue',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'AutoScannerMonitor',
        provider: ownerName,
        queueSize: this.state.queuedProviders.size,
        action: 'added',
      });
    }

    /* Debounce tracking — each file event triggers _schedule() in the controller */
    if (!wasEmpty && !this.state.isFlushing) {
      /* Timer was reset (cancelled + re-scheduled) */
      this.state.totalDebounceCancelled++;
      this.state.totalDebounceScheduled++;
      this.state.debounceStartTime = now;
      this.emit({
        type: 'autoscan.debounce',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'AutoScannerMonitor',
        action: 'cancelled',
        debounceMs: now - this.state.debounceStartTime,
        queueSize: this.state.queuedProviders.size,
      });
      this.emit({
        type: 'autoscan.debounce',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'AutoScannerMonitor',
        action: 'scheduled',
        debounceMs: 0,
        queueSize: this.state.queuedProviders.size,
      });
    } else if (wasEmpty) {
      /* First event in cycle — new debounce scheduled */
      this.state.totalDebounceScheduled++;
      this.state.debounceStartTime = now;
      this.emit({
        type: 'autoscan.debounce',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'AutoScannerMonitor',
        action: 'scheduled',
        debounceMs: 0,
        queueSize: this.state.queuedProviders.size,
      });
    }
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
      debounceStartTime: 0,
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

  private emit(event: AutoScannerTelemetryEvent): void {
    try {
      this.reporter.report(event);
    } catch (e) {
      console.error('[AutoScannerMonitor] emit failed:', e);
    }
  }
}

/** Create an AutoScannerMonitor attached to the given manager and reporter */
export const createAutoScannerMonitor: typeof AutoScannerMonitor.create = AutoScannerMonitor.create;
