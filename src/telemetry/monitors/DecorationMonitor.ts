import {
  CancellationToken,
  FileDecoration,
  Uri,
} from 'vscode';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { TelemetryReporter, TelemetryEvent } from '../../telemetry';
import { generateTraceId } from '../../telemetry';
import { ProblemStore } from '../../store/ProblemStore';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

/** Trigger: fireDidChange() was called */
export interface DecorationRefreshStartEventData extends TelemetryEvent {
  readonly type: 'decoration.refresh.start';
  readonly source: 'DecorationMonitor';
  readonly callType: 'full' | 'array' | 'single';
  readonly uriCount: number;
  readonly uris?: string[];
  readonly trigger?: string;
  readonly correlationId?: string;
}

/** Trigger: coalesced fire was delivered to VS Code */
export interface DecorationFireEventData extends TelemetryEvent {
  readonly type: 'decoration.fire';
  readonly source: 'DecorationMonitor';
  readonly uris?: string[];
  readonly uriCount: number;
  readonly coalesced: boolean;
  readonly queueLatencyMs: number;
}

/** Trigger: provideFileDecoration was called */
export interface DecorationProvideStartEventData extends TelemetryEvent {
  readonly type: 'decoration.provide.start';
  readonly source: 'DecorationMonitor';
  readonly uri: string;
}

/** Trigger: provideFileDecoration returned a result */
export interface DecorationProvideEventData extends TelemetryEvent {
  readonly type: 'decoration.provide';
  readonly source: 'DecorationMonitor';
  readonly uri: string;
  readonly hit: boolean;
  readonly badge?: string;
  readonly badgeLength: number;
  readonly colorId?: string;
  readonly tooltip?: string;
  readonly severity?: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly fileCount: number;
  readonly executionTimeMs: number;
  readonly cached: boolean;
  readonly reasonSkipped?: string;
}

/** Trigger: a decoration decision was made during pipeline */
export interface DecorationDecisionEventData extends TelemetryEvent {
  readonly type: 'decoration.decision';
  readonly source: 'DecorationMonitor';
  readonly uri: string;
  readonly step: string;
  readonly outcome: string;
  readonly detail?: string;
}

/** Trigger: runtime assertion */
export interface DecorationAssertionEventData extends TelemetryEvent {
  readonly type: 'decoration.assertion';
  readonly source: 'DecorationMonitor';
  readonly code: string;
  readonly message: string;
  readonly uri?: string;
  readonly detail?: string;
}

/** Union of all decoration monitor event types */
export type DecorationTelemetryEvent =
  | DecorationRefreshStartEventData
  | DecorationFireEventData
  | DecorationProvideStartEventData
  | DecorationProvideEventData
  | DecorationDecisionEventData
  | DecorationAssertionEventData;

/* ------------------------------------------------------------------ */
/*  Statistics & Snapshot interfaces                                   */
/* ------------------------------------------------------------------ */

export interface DecorationStatistics {
  totalRefreshes: number;
  totalFires: number;
  totalProvideCalls: number;
  totalDecorationsReturned: number;
  totalSkipped: number;
  totalCacheHits: number;
  totalCacheMisses: number;
  provideDurationSumMs: number;
  peakProvideDurationMs: number;
  coalescedBatches: number;
  duplicateRefreshesDetected: number;
  totalUrisRefreshed: number;
  totalAssertions: number;
  averageProvideDurationMs: number;
  cacheHitRatio: number;
  averageRefreshSize: number;
  decorationsPerSecond: number;
}

export interface DecorationSnapshot {
  activeRefreshCount: number;
  activeProvideCount: number;
  coalesceQueueSize: number;
  statistics: DecorationStatistics;
}

/* ------------------------------------------------------------------ */
/*  DecorationMonitor                                                  */
/* ------------------------------------------------------------------ */

/** Monitors DecorationEngine by wrapping its public methods */
export class DecorationMonitor {
  private readonly originalFireDidChange: (uris: Uri | Uri[] | undefined) => void;
  private readonly originalProvideFileDecoration: (uri: Uri, token: CancellationToken) => FileDecoration | undefined;
  private readonly stats: DecorationStatistics;
  private disposed = false;

  /* Concurrency tracking */
  private activeRefreshCount = 0;
  private activeProvideCount = 0;

  /* Coalesce observation */
  private _coalesceQueueSize = 0;
  private _lastRefreshTimestamp = 0;
  private _pendingFireUris = new Set<string>();
  private _pendingFireIsFull = false;

  /* Decoration fire subscription */
  private readonly _fireSubscription: { dispose(): void };

  /* Performance counters */
  private _statsStarted = Date.now();

  constructor(
    private readonly engine: DecorationEngine,
    private readonly reporter: TelemetryReporter,
    private readonly problemStore?: ProblemStore,
  ) {
    this.originalFireDidChange = engine.fireDidChange.bind(engine);
    this.originalProvideFileDecoration = engine.provideFileDecoration.bind(engine);

    /* Subscribe to actual decoration fire events from the engine */
    this._fireSubscription = engine.onDidChangeFileDecorations((uris: Uri | Uri[] | undefined) => {
      this._onDecorationFire(uris);
    });

    this.stats = {
      totalRefreshes: 0,
      totalFires: 0,
      totalProvideCalls: 0,
      totalDecorationsReturned: 0,
      totalSkipped: 0,
      totalCacheHits: 0,
      totalCacheMisses: 0,
      provideDurationSumMs: 0,
      peakProvideDurationMs: 0,
      coalescedBatches: 0,
      duplicateRefreshesDetected: 0,
      totalUrisRefreshed: 0,
      totalAssertions: 0,
      averageProvideDurationMs: 0,
      cacheHitRatio: 0,
      averageRefreshSize: 0,
      decorationsPerSecond: 0,
    };

    /* problemStore available for sub-tasks */
    void this.problemStore;

    this.wrapMethods();
  }

  /* ------------------------------------------------------------------ */
  /*  Method wrapping                                                     */
  /* ------------------------------------------------------------------ */

  private wrapMethods(): void {
    const self = this;

    this.engine.fireDidChange = function (uris: Uri | Uri[] | undefined): void {
      if (self.disposed) { self.originalFireDidChange(uris); return; }
      self.handleFireDidChange(uris);
    };

    this.engine.provideFileDecoration = function (
      uri: Uri,
      token: CancellationToken,
    ): FileDecoration | undefined {
      if (self.disposed) { return self.originalProvideFileDecoration(uri, token); }
      return self.handleProvideFileDecoration(uri, token);
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Event emit helpers                                                  */
  /* ------------------------------------------------------------------ */

  private _emit(event: DecorationTelemetryEvent): void {
    this.reporter.report(event as TelemetryEvent);
  }

  /** Extract caller info from stack trace */
  private _getCaller(): string {
    try {
      throw new Error();
    } catch (e: unknown) {
      const stack = (e as Error).stack ?? '';
      const lines = stack.split('\n');
      /* Skip our own frames (index 0-3) to find the actual caller */
      for (let i = 3; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.includes('DecorationMonitor') && !line.includes('Error')) {
          return line.replace(/^at\s+/, '').trim();
        }
      }
      return 'unknown';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Snapshot & Statistics                                              */
  /* ------------------------------------------------------------------ */

  getStatistics(): DecorationStatistics {
    const elapsedSec = (Date.now() - this._statsStarted) / 1000;
    const s = { ...this.stats };
    s.averageProvideDurationMs = s.totalProvideCalls > 0
      ? Math.round(s.provideDurationSumMs / s.totalProvideCalls) : 0;
    s.cacheHitRatio = (s.totalCacheHits + s.totalCacheMisses) > 0
      ? Math.round((s.totalCacheHits / (s.totalCacheHits + s.totalCacheMisses)) * 100) : 0;
    s.averageRefreshSize = s.totalRefreshes > 0
      ? Math.round(s.totalUrisRefreshed / s.totalRefreshes) : 0;
    s.decorationsPerSecond = elapsedSec > 0
      ? Math.round(s.totalProvideCalls / elapsedSec) : 0;
    return s;
  }

  captureSnapshot(): DecorationSnapshot {
    return {
      activeRefreshCount: this.activeRefreshCount,
      activeProvideCount: this.activeProvideCount,
      coalesceQueueSize: this._coalesceQueueSize,
      statistics: this.getStatistics(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Dispose                                                             */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.fireDidChange = this.originalFireDidChange;
    this.engine.provideFileDecoration = this.originalProvideFileDecoration;
    this._fireSubscription.dispose();
  }

  /* ------------------------------------------------------------------ */
  /*  Refresh monitoring                                                  */
  /* ------------------------------------------------------------------ */

  private handleFireDidChange(uris: Uri | Uri[] | undefined): void {
    const ts = Date.now();
    let callType: 'full' | 'array' | 'single';
    let uriCount: number;
    let uriStrs: string[] | undefined;

    if (uris === undefined) {
      callType = 'full';
      uriCount = 0;
      this._pendingFireIsFull = true;
    } else if (Array.isArray(uris)) {
      callType = 'array';
      uriCount = uris.length;
      uriStrs = uris.map((u) => u.toString());
      for (const u of uriStrs) { this._pendingFireUris.add(u); }
    } else {
      callType = 'single';
      uriCount = 1;
      uriStrs = [uris.toString()];
      this._pendingFireUris.add(uriStrs[0]);
    }

    this.activeRefreshCount++;
    this.stats.totalRefreshes++;
    this.stats.totalUrisRefreshed += uriCount;
    this._lastRefreshTimestamp = ts;

    const caller = this._getCaller();

    /* Emit start event */
    this._emit({
      type: 'decoration.refresh.start',
      timestamp: ts,
      traceId: generateTraceId(),
      source: 'DecorationMonitor',
      callType,
      uriCount,
      uris: uriStrs,
      trigger: caller,
    });

    /* Call through to original */
    this.originalFireDidChange(uris);

    this.activeRefreshCount--;
  }

  /** Called when the engine actually fires decoration change to VS Code */
  private _onDecorationFire(uris: Uri | Uri[] | undefined): void {
    let uriStrs: string[] | undefined;
    let uriCount: number;
    let coalesced: boolean;

    if (uris === undefined) {
      uriCount = 0;
      coalesced = this._pendingFireIsFull;
      this._pendingFireIsFull = false;
    } else if (Array.isArray(uris)) {
      uriStrs = uris.map((u) => u.toString());
      uriCount = uriStrs.length;
      coalesced = true;
      /* Remove fired URIs from pending set */
      for (const u of uriStrs) { this._pendingFireUris.delete(u); }
    } else {
      uriStrs = [uris.toString()];
      uriCount = 1;
      coalesced = !this._pendingFireIsFull; /* single URI fires are typically coalesced */
      this._pendingFireUris.delete(uriStrs[0]);
    }

    this._coalesceQueueSize = this._pendingFireUris.size;
    this.stats.totalFires++;
    if (coalesced) { this.stats.coalescedBatches++; }

    const queueLatencyMs = this._lastRefreshTimestamp > 0 ? Date.now() - this._lastRefreshTimestamp : 0;

    this._emit({
      type: 'decoration.fire',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'DecorationMonitor',
      uris: uriStrs,
      uriCount,
      coalesced,
      queueLatencyMs,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Decoration provider monitoring                                      */
  /* ------------------------------------------------------------------ */

  private handleProvideFileDecoration(uri: Uri, token: CancellationToken): FileDecoration | undefined {
    return this.originalProvideFileDecoration(uri, token);
  }
}

/** Create a DecorationMonitor attached to the given engine and reporter */
export function createDecorationMonitor(
  engine: DecorationEngine,
  reporter: TelemetryReporter,
  problemStore?: ProblemStore,
): DecorationMonitor {
  return new DecorationMonitor(engine, reporter, problemStore);
}
