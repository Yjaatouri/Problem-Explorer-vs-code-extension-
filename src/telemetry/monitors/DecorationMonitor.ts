import {
  CancellationToken,
  FileDecoration,
  Uri,
  workspace,
} from 'vscode';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { TelemetryReporter, TelemetryEvent } from '../../telemetry';
import { generateTraceId } from '../../telemetry';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
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
  readonly correlationId?: string;
}

/** Trigger: provideFileDecoration was called */
export interface DecorationProvideStartEventData extends TelemetryEvent {
  readonly type: 'decoration.provide.start';
  readonly source: 'DecorationMonitor';
  readonly uri: string;
  readonly correlationId?: string;
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
  readonly correlationId?: string;
}

/** Trigger: a decoration decision was made during pipeline */
export interface DecorationDecisionEventData extends TelemetryEvent {
  readonly type: 'decoration.decision';
  readonly source: 'DecorationMonitor';
  readonly uri: string;
  readonly step: string;
  readonly outcome: string;
  readonly detail?: string;
  readonly correlationId?: string;
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
  totalFirstTimeRequests: number;
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
  private _firstRefreshTimestamp = 0;
  private _pendingFireUris = new Set<string>();


  /* Decoration result cache for hit/miss tracking */
  private _lastDecoration = new Map<string, { badge?: string; colorId?: string; tooltip?: string; timestamp: number }>();

  /* Refresh counter excluding full refreshes (for accurate average) */
  private _nonFullRefreshCount = 0;

  /* Loop detection counter */
  private _decorationLoopCount = new Map<string, number>();

  /* Decoration fire subscription */
  private readonly _fireSubscription: { dispose(): void };

  /* Refresh history for duplicate detection */
  private readonly _refreshHistory = new Map<string, number>();

  /* Flow correlation: recent store changes mapped by URI */
  private readonly _recentChanges = new Map<string, { correlationId: string; traceId: string; timestamp: number }>();
  private readonly _correlationSubscription: TelemetrySubscription;
  private _correlationCleanupTimer: ReturnType<typeof setInterval> | undefined;

  /* Performance counters */
  private _statsStarted = Date.now();

  /** If true, capture stack traces on fireDidChange to identify callers (expensive) */
  private _captureCaller = false;

  /** Enable or disable stack trace capture on fireDidChange */
  setCaptureCaller(enabled: boolean): void {
    this._captureCaller = enabled;
  }

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

    /* Subscribe to telemetry events for flow correlation */
    this._correlationSubscription = reporter.subscribeAll((event: TelemetryEvent) => {
      this._onTelemetryEvent(event);
    });

    /* Periodic cleanup of stale correlation entries (every 5s) */
    this._correlationCleanupTimer = setInterval(() => {
      this._cleanupStaleCorrelations();
    }, 5000);

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
      totalFirstTimeRequests: 0,
    };

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

  /** Safely extract the color ID from a FileDecoration */
  private _getColorId(deco: FileDecoration | undefined): string | undefined {
    return (deco?.color as any)?.id;
  }

  /** Extract caller info from stack trace (expensive — disabled by default) */
  private _getCaller(): string {
    if (!this._captureCaller) return 'unknown';
    try {
      throw new Error();
    } catch (e: unknown) {
      const stack = (e as Error).stack ?? '';
      const lines = stack.split('\n');
      for (let i = 3; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.includes('DecorationMonitor') && !line.includes('Error')) {
          return line.replace(/^at\s+/, '').trim();
        }
      }
      return 'unknown';
    }
  }

  /** Emit a decision point in the decoration pipeline */
  private _emitDecision(uri: string, step: string, outcome: string, detail?: string): void {
    this._emit({
      type: 'decoration.decision',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'DecorationMonitor',
      uri,
      step,
      outcome,
      detail,
    });
  }

  /** Emit a runtime assertion */
  private _emitAssertion(code: string, message: string, uri?: string, detail?: string): void {
    this.stats.totalAssertions++;
    this._emit({
      type: 'decoration.assertion',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'DecorationMonitor',
      code,
      message,
      uri,
      detail,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Runtime assertions                                                  */
  /* ------------------------------------------------------------------ */

  /** Assert: check for duplicate refreshes of the same URI */
  private _assertDuplicateRefresh(uriStrs: string[] | undefined): void {
    const now = Date.now();

    /* Track full refresh duplicates */
    if (!uriStrs) {
      const lastFull = this._refreshHistory.get('__full_refresh__');
      if (lastFull !== undefined && (now - lastFull) < 100) {
        this.stats.duplicateRefreshesDetected++;
        this._emitAssertion('DUPLICATE_REFRESH', 'Duplicate full refresh',
          undefined, `lastRefresh=${now - lastFull}ms ago`);
      }
      this._refreshHistory.set('__full_refresh__', now);
      return;
    }

    for (const u of uriStrs) {
      const lastRefresh = this._refreshHistory.get(u);
      if (lastRefresh !== undefined && (now - lastRefresh) < 100) {
        this.stats.duplicateRefreshesDetected++;
        this._emitAssertion('DUPLICATE_REFRESH', `Duplicate refresh for ${u}`, u,
          `lastRefresh=${now - lastRefresh}ms ago`);
      }
      this._refreshHistory.set(u, now);
    }
  }

  /** Assert: decoration returned but no state in store */
  private _assertDecorationWithoutState(uriStr: string, result: FileDecoration | undefined): void {
    if (!result) return;
    if (this.problemStore) {
      const state = this.problemStore.get(Uri.parse(uriStr));
      if (!state) {
        this._emitAssertion('DECORATION_WITHOUT_STATE',
          `Decoration returned for ${uriStr} but no state in store`,
          uriStr, `badge=${result.badge} tooltip=${result.tooltip}`);
      } else if (state.severity === 0) {
        this._emitAssertion('DECORATION_WITHOUT_STATE',
          `Decoration returned for ${uriStr} but severity is None`,
          uriStr, `severity=${state.severity}`);
      }
    }
  }

  /** Assert: state in store but no decoration returned */
  private _assertStateWithoutDecoration(uriStr: string, result: FileDecoration | undefined, reasonSkipped?: string): void {
    if (result) return;
    if (this.problemStore) {
      const state = this.problemStore.get(Uri.parse(uriStr));
      if (state && state.severity > 0 && reasonSkipped === 'unknown') {
        this._emitAssertion('STATE_WITHOUT_DECORATION',
          `State exists for ${uriStr} but no decoration returned`,
          uriStr, `severity=${state.severity} errors=${state.errorCount} reason=${reasonSkipped}`);
      }
    }
  }

  /** Assert: invalid badge string */
  private _assertInvalidBadge(uriStr: string, badge: string | undefined): void {
    if (!badge) return;
    if (badge.length > 2) {
      this._emitAssertion('INVALID_BADGE', `Badge too long for ${uriStr}: "${badge}" (len=${badge.length})`, uriStr,
        `badge=${badge} maxLength=2`);
    }
    if (/[^a-zA-Z0-9+]/.test(badge)) {
      this._emitAssertion('INVALID_BADGE', `Badge has invalid chars for ${uriStr}: "${badge}"`, uriStr,
        `badge=${badge}`);
    }
  }

  /** Assert: invalid severity value */
  private _assertInvalidSeverity(uriStr: string, severity: number | undefined): void {
    if (severity === undefined) return;
    if (severity < 0 || severity > 3) {
      this._emitAssertion('INVALID_SEVERITY', `Invalid severity ${severity} for ${uriStr}`, uriStr,
        `severity=${severity} expected=[0-3]`);
    }
  }

  /** Assert: invalid color (decoration returned without color) */
  private _assertInvalidColor(uriStr: string, result: FileDecoration | undefined): void {
    if (!result) return;
    if (!result.color) {
      this._emitAssertion('INVALID_COLOR', `Decoration for ${uriStr} has no color`, uriStr,
        `badge=${result.badge} tooltip=${result.tooltip}`);
    }
  }

  /** Assert: repeated decoration loops (same result returned many times for the same URI) */
  private _assertRepeatedDecoration(uriStr: string, result: FileDecoration | undefined): void {
    const key = `${uriStr}::${result?.badge ?? 'none'}::${this._getColorId(result) ?? 'none'}`;
    const count = this._decorationLoopCount.get(key) ?? 0;
    this._decorationLoopCount.set(key, count + 1);
    if (count + 1 >= 10) {
      this._emitAssertion('REPEATED_DECORATION', `Decoration loop detected for ${uriStr}: same result ${count + 1} times`,
        uriStr, `badge=${result?.badge} colorId=${this._getColorId(result)}`);
    }
  }

  /** Assert: impossible decoration transition (severity changed without store change) */
  private _assertImpossibleTransition(uriStr: string, resultBadge: string | undefined): void {
    const prev = this._lastDecoration.get(uriStr);
    if (prev && prev.badge && resultBadge && prev.badge !== resultBadge) {
      /* Check if a store change occurred between the two provide calls */
      const storeEntry = this._recentChanges.get(uriStr);
      if (!storeEntry || (Date.now() - storeEntry.timestamp) > 5000) {
        this._emitAssertion('IMPOSSIBLE_TRANSITION',
          `Decoration changed from "${prev.badge}" to "${resultBadge}" for ${uriStr} without store change`,
          uriStr, `prevBadge=${prev.badge} newBadge=${resultBadge}`);
      }
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
    s.averageRefreshSize = this._nonFullRefreshCount > 0
      ? Math.round(s.totalUrisRefreshed / this._nonFullRefreshCount) : 0;
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
  /*  Flow correlation                                                    */
  /* ------------------------------------------------------------------ */

  /** Process telemetry events from other monitors to build correlation state */
  private _onTelemetryEvent(event: TelemetryEvent): void {
    if (this.disposed) return;
    const data = event as any;

    /* Track store.set events by URI */
    if (event.type === 'store.set' && data.uri && data.correlationId) {
      this._recentChanges.set(data.uri, {
        correlationId: data.correlationId,
        traceId: event.traceId,
        timestamp: Date.now(),
      });
    }

    /* Track store.delete events by URI */
    if (event.type === 'store.delete' && data.uri && data.correlationId) {
      this._recentChanges.set(data.uri, {
        correlationId: data.correlationId,
        traceId: event.traceId,
        timestamp: Date.now(),
      });
    }

    /* Track folder propagation events */
    if (event.type === 'folder.propagation' && data.fileUri && data.correlationId) {
      /* Propagate to all affected URIs */
      const uris: string[] = data.foldersUpdated ?? [data.fileUri];
      for (const u of uris) {
        this._recentChanges.set(u, {
          correlationId: data.correlationId,
          traceId: event.traceId,
          timestamp: Date.now(),
        });
      }
    }
  }

  /** Look up correlation ID for a URI from recent store changes */
  private _getCorrelationId(uriStr: string): string | undefined {
    const entry = this._recentChanges.get(uriStr);
    if (entry && (Date.now() - entry.timestamp) < 5000) {
      return entry.correlationId;
    }
    return undefined;
  }

  /** Remove stale correlation entries older than 5 seconds */
  private _cleanupStaleCorrelations(): void {
    const cutoff = Date.now() - 5000;
    for (const [uri, entry] of this._recentChanges) {
      if (entry.timestamp < cutoff) {
        this._recentChanges.delete(uri);
      }
    }
    /* Also clean stale refresh history (older than 5 seconds) */
    for (const [uri, ts] of this._refreshHistory) {
      if (ts < cutoff) {
        this._refreshHistory.delete(uri);
      }
    }
    /* Cap _lastDecoration to 1000 entries (oldest removed) */
    if (this._lastDecoration.size > 1000) {
      const entries = [...this._lastDecoration.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - 1000);
      for (const [uri] of toDelete) {
        this._lastDecoration.delete(uri);
      }
    }
    /* Cap _decorationLoopCount to 5000 entries (oldest removed) */
    if (this._decorationLoopCount.size > 5000) {
      const entries = [...this._decorationLoopCount.entries()];
      const toDelete = entries.slice(0, entries.length - 5000);
      for (const [key] of toDelete) {
        this._decorationLoopCount.delete(key);
      }
    }
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
    this._correlationSubscription.dispose();
    if (this._correlationCleanupTimer) {
      clearInterval(this._correlationCleanupTimer);
      this._correlationCleanupTimer = undefined;
    }
    this.activeRefreshCount = 0;
    this.activeProvideCount = 0;
    this._recentChanges.clear();
    this._refreshHistory.clear();
    this._lastDecoration.clear();
    this._decorationLoopCount.clear();
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
      this._firstRefreshTimestamp = 0; /* reset - all pending fired */
    } else if (Array.isArray(uris)) {
      callType = 'array';
      uriCount = uris.length;
      this._nonFullRefreshCount++;
      uriStrs = uris.map((u) => u.toString());
      const wasEmpty = this._pendingFireUris.size === 0;
      for (const u of uriStrs) { this._pendingFireUris.add(u); }
      if (wasEmpty) { this._firstRefreshTimestamp = ts; }
    } else {
      callType = 'single';
      uriCount = 1;
      this._nonFullRefreshCount++;
      uriStrs = [uris.toString()];
      const wasEmpty = this._pendingFireUris.size === 0;
      this._pendingFireUris.add(uriStrs[0]);
      if (wasEmpty) { this._firstRefreshTimestamp = ts; }
    }

    this.activeRefreshCount++;
    this.stats.totalRefreshes++;
    this.stats.totalUrisRefreshed += uriCount;
    try {
      const caller = this._getCaller();

      /* Derive correlation ID from the first changed URI */
      let correlationId: string | undefined;
      if (uriStrs && uriStrs.length > 0) {
        for (const u of uriStrs) {
          const cid = this._getCorrelationId(u);
          if (cid) { correlationId = cid; break; }
        }
      }

      /* Assert: duplicate refresh detection */
      this._assertDuplicateRefresh(uriStrs);

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
        correlationId,
      });

      /* Call through to original */
      this.originalFireDidChange(uris);
    } finally {
      this.activeRefreshCount--;
    }
  }

  /** Called when the engine actually fires decoration change to VS Code */
  private _onDecorationFire(uris: Uri | Uri[] | undefined): void {
    let uriStrs: string[] | undefined;
    let uriCount: number;
    let coalesced: boolean;

    /* Capture queue latency using first refresh timestamp (when pending was empty before adding) */
    const queueLatencyMs = this._firstRefreshTimestamp > 0 ? Date.now() - this._firstRefreshTimestamp : 0;
    const now = Date.now();

    if (uris === undefined) {
      /* Full fire - all pending URIs fired */
      uriCount = this._pendingFireUris.size;
      coalesced = uriCount > 0;
      this._pendingFireUris.clear();
    } else if (Array.isArray(uris)) {
      uriStrs = uris.map((u) => u.toString());
      uriCount = uriStrs.length;
      /* Batched fire - coalesced if there were other pending items before this batch */
      coalesced = this._pendingFireUris.size > uriCount;
      /* Remove fired URIs from pending set */
      for (const u of uriStrs) { this._pendingFireUris.delete(u); }
    } else {
      uriStrs = [uris.toString()];
      uriCount = 1;
      /* Single URI fire - coalesced if there were other pending items */
      coalesced = this._pendingFireUris.size > 1;
      this._pendingFireUris.delete(uriStrs[0]);
    }

    this._coalesceQueueSize = this._pendingFireUris.size;
    this.stats.totalFires++;
    if (coalesced) { this.stats.coalescedBatches++; }

    /* Derive correlation ID from fired URIs */
    let correlationId: string | undefined;
    if (uriStrs && uriStrs.length > 0) {
      for (const u of uriStrs) {
        const cid = this._getCorrelationId(u);
        if (cid) { correlationId = cid; break; }
      }
    }

    this._emit({
      type: 'decoration.fire',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'DecorationMonitor',
      uris: uriStrs,
      uriCount,
      coalesced,
      queueLatencyMs,
      correlationId,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Decoration provider monitoring                                      */
  /* ------------------------------------------------------------------ */

  private handleProvideFileDecoration(uri: Uri, token: CancellationToken): FileDecoration | undefined {
    const ts = Date.now();
    const uriStr = uri.toString();
    this.activeProvideCount++;

    try {
      /* Derive correlation ID for this URI */
      const provideCorrelationId = this._getCorrelationId(uriStr);

      /* Emit start event */
      this._emit({
        type: 'decoration.provide.start',
        timestamp: ts,
        traceId: generateTraceId(),
        source: 'DecorationMonitor',
        uri: uriStr,
        correlationId: provideCorrelationId,
      });

      /* Decision: workspace folder check */
      const wf = workspace.getWorkspaceFolder(uri);
      this._emitDecision(uriStr, 'wsFolderCheck', wf ? 'found' : 'missing', wf ? wf.name : undefined);

      /* Decision: store lookup */
      const storeState = this.problemStore?.get(uri);
      this._emitDecision(uriStr, 'storeLookup', storeState ? 'found' : 'missing',
        storeState ? `severity=${storeState.severity} errors=${storeState.errorCount} warnings=${storeState.warningCount}` : undefined);

      let result: FileDecoration | undefined;
      let executionTimeMs: number;
      let error: string | undefined;

      try {
        result = this.originalProvideFileDecoration(uri, token);
        /* Guard against async return values */
        if (result instanceof Promise) {
          this._emitAssertion('ASYNC_RETURN', 'provideFileDecoration returned a Promise — monitoring skipped',
            uriStr, 'The underlying engine returned a Promise instead of a synchronous result');
          return result as unknown as FileDecoration | undefined;
        }
        executionTimeMs = Date.now() - ts;
      } catch (e: unknown) {
        executionTimeMs = Date.now() - ts;
        error = e instanceof Error ? e.message : String(e);
        result = undefined;
      }

      this.stats.totalProvideCalls++;

      /* Determine skip reason when no decoration returned */
      let reasonSkipped: string | undefined;
      let severity: number | undefined;
      let errorCount = 0;
      let warningCount = 0;
      let infoCount = 0;
      let fileCount = 0;

      if (!result || error) {
        this.stats.totalSkipped++;
        if (error) {
          reasonSkipped = `exception: ${error}`;
        } else {
          if (!wf) {
            reasonSkipped = 'no workspace folder';
          } else if (this.problemStore) {
            if (!storeState) {
              reasonSkipped = 'no state in store';
            } else {
              severity = storeState.severity;
              errorCount = storeState.errorCount;
              warningCount = storeState.warningCount;
              infoCount = storeState.infoCount;
              fileCount = storeState.fileCount;
              if (storeState.severity === 0) {
                reasonSkipped = 'severity None';
              } else {
                reasonSkipped = 'unknown (config: disabled/showWarnings/ignored)';
              }
            }
          } else {
            reasonSkipped = 'unknown';
          }
        }
      } else {
        this.stats.totalDecorationsReturned++;
        if (storeState) {
          severity = storeState.severity;
          errorCount = storeState.errorCount;
          warningCount = storeState.warningCount;
          infoCount = storeState.infoCount;
          fileCount = storeState.fileCount;
        }
      }

      /* Decision: severity evaluation */
      this._emitDecision(uriStr, 'severityEvaluation',
        severity !== undefined ? `severity=${severity}` : 'no state',
        `errors=${errorCount} warnings=${warningCount} infos=${infoCount}`);

      /* Decision: decoration result */
      if (result) {
        this._emitDecision(uriStr, 'badgeSelection', `badge=${result.badge ?? 'none'}`, `length=${result.badge?.length ?? 0}`);
        this._emitDecision(uriStr, 'colorSelection', `colorId=${this._getColorId(result) ?? 'none'}`);
        this._emitDecision(uriStr, 'tooltipFormat', `tooltip=${result.tooltip ?? 'none'}`);
      } else {
        this._emitDecision(uriStr, 'decorationResult', 'noDecoration', reasonSkipped);
      }

      /* Run runtime assertions */
      this._assertInvalidSeverity(uriStr, severity);
      this._assertDecorationWithoutState(uriStr, result);
      this._assertStateWithoutDecoration(uriStr, result, reasonSkipped);
      this._assertInvalidBadge(uriStr, result?.badge);
      this._assertInvalidColor(uriStr, result);
      this._assertRepeatedDecoration(uriStr, result);
      this._assertImpossibleTransition(uriStr, result?.badge);

      /* Cache hit/miss detection */
      const prev = this._lastDecoration.get(uriStr);
      const isFirstTime = prev === undefined;
      const cached = !isFirstTime && (
        prev.badge === result?.badge &&
        prev.colorId === this._getColorId(result) &&
        prev.tooltip === result?.tooltip
      );
      if (isFirstTime) {
        this.stats.totalFirstTimeRequests++;
        this._lastDecoration.set(uriStr, {
          badge: result?.badge,
          colorId: this._getColorId(result),
          tooltip: result?.tooltip,
          timestamp: Date.now(),
        });
      } else if (cached) {
        this.stats.totalCacheHits++;
      } else {
        this.stats.totalCacheMisses++;
        this._lastDecoration.set(uriStr, {
          badge: result?.badge,
          colorId: this._getColorId(result),
          tooltip: result?.tooltip,
          timestamp: Date.now(),
        });
      }

      /* Track peak duration */
      if (executionTimeMs > this.stats.peakProvideDurationMs) {
        this.stats.peakProvideDurationMs = executionTimeMs;
      }
      this.stats.provideDurationSumMs += executionTimeMs;

      /* Emit completion event */
      this._emit({
        type: 'decoration.provide',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'DecorationMonitor',
        uri: uriStr,
        hit: !!result,
        badge: result?.badge,
        badgeLength: result?.badge?.length ?? 0,
        colorId: this._getColorId(result),
        tooltip: result?.tooltip,
        severity,
        errorCount,
        warningCount,
        infoCount,
        fileCount,
        executionTimeMs,
        cached,
        reasonSkipped,
        correlationId: provideCorrelationId,
      });

      return result;
    } finally {
      this.activeProvideCount--;
    }
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
