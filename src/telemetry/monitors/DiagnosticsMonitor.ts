import { Disposable, languages, DiagnosticChangeEvent, Uri } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemStoreChange } from '../../models/ProblemStoreChange';
import { TelemetryReporter, TelemetryEvent } from '../../telemetry';
import { TraceId, generateTraceId } from '../../telemetry';
import { ProblemState, ProblemSeverity } from '../../core/types';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

/** Trigger: VS Code emitted a raw diagnostics change */
export interface DiagnosticsChangeEventData {
  readonly type: 'diagnostics.change';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly uriCount: number;
  readonly uris: readonly string[];
}

/** Trigger: a single diagnostic was mapped to ProblemState */
export interface DiagnosticsMappingEventData {
  readonly type: 'diagnostics.mapping';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly uri: string;
  readonly diagnosticCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly mappingDurationUs: number;
  readonly success: boolean;
  readonly failureReason?: string;
}

/** Trigger: a ProblemState was written (or rejected) via store.set() */
export interface DiagnosticsStoreWriteEventData {
  readonly type: 'diagnostics.storeWrite';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly uri: string;
  readonly provider: string;
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly accepted: boolean;
  readonly rejectReason?: string;
  readonly ownerBefore?: string;
  readonly ownerAfter?: string;
  readonly writeDurationUs: number;
}

/** Trigger: ownership of a URI was transferred or disputed */
export interface DiagnosticsOwnershipEventData {
  readonly type: 'diagnostics.ownership';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly uri: string;
  readonly provider: string;
  readonly previousOwner?: string;
  readonly action: 'acquired' | 'transferred' | 'disputed' | 'released';
}

/** Trigger: diagnostics state changed for a URI (add/remove/update/stale/duplicate) */
export interface DiagnosticsStateChangeEventData {
  readonly type: 'diagnostics.stateChange';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly uri: string;
  readonly change: 'added' | 'removed' | 'updated' | 'stale' | 'duplicate';
  readonly previousState?: ProblemState;
  readonly currentState?: ProblemState;
  readonly provider?: string;
}

/** Trigger: a runtime assertion fired */
export interface DiagnosticsAssertionEventData {
  readonly type: 'diagnostics.assertion';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly assertion: string;
  readonly detail: string;
}

/** Trigger: periodic performance snapshot */
export interface DiagnosticsSnapshotEventData {
  readonly type: 'diagnostics.snapshot';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'DiagnosticsMonitor';
  readonly statistics: DiagnosticsStatistics;
}

/* ------------------------------------------------------------------ */
/*  Union type                                                         */
/* ------------------------------------------------------------------ */

export type DiagnosticsTelemetryEvent =
  | DiagnosticsChangeEventData
  | DiagnosticsMappingEventData
  | DiagnosticsStoreWriteEventData
  | DiagnosticsOwnershipEventData
  | DiagnosticsStateChangeEventData
  | DiagnosticsAssertionEventData
  | DiagnosticsSnapshotEventData;

/* ------------------------------------------------------------------ */
/*  Statistics & snapshot interfaces                                   */
/* ------------------------------------------------------------------ */

/** Cumulative diagnostics statistics for a single cycle */
export interface DiagnosticsStatistics {
  totalChanges: number;
  totalUris: number;
  totalFlushUpdates: number;
  totalFlushUris: number;
  totalMappings: number;
  totalStoreWrites: number;
  totalAcceptedWrites: number;
  totalRejectedWrites: number;
  totalOwnershipTransfers: number;
  totalOwnershipDisputes: number;
  totalStateAdds: number;
  totalStateRemoves: number;
  totalStateUpdates: number;
  totalDuplicateDiagnostics: number;
  totalAssertions: number;
  mappingDurationSumUs: number;
  writeDurationSumUs: number;
  peakMappingDurationUs: number;
  peakWriteDurationUs: number;
}

/** Point-in-time snapshot of diagnostics monitor state */
export interface DiagnosticsSnapshot {
  activeMappings: number;
  pendingWrites: number;
  statistics: DiagnosticsStatistics;
}

/* ------------------------------------------------------------------ */
/*  DiagnosticsMonitor                                                 */
/* ------------------------------------------------------------------ */

/**
 * Production-quality monitor for the complete diagnostics lifecycle.
 *
 * Observes:
 *  - VS Code onDidChangeDiagnostics
 *  - Diagnostic → ProblemState mapping pipeline
 *  - ProblemStore.set() writes and ownership
 *  - State changes (add/remove/update/stale/duplicate)
 *  - Runtime assertions
 *  - Performance metrics
 */
export class DiagnosticsMonitor implements Disposable {
  private disposed = false;
  private readonly disposables: Disposable[] = [];

  /* Diagnostics change tracking */
  private readonly knownUris = new Set<string>();
  private vsDiagProvider: DiagnosticProvider | undefined;

  /* Pipeline timing */
  private activeMappings = 0;
  private pendingWrites = 0;
  private readonly mappingStartTimes = new Map<string, number>();
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;

  /* Cumulative statistics */
  private readonly stats: DiagnosticsStatistics = {
    totalChanges: 0,
    totalUris: 0,
    totalFlushUpdates: 0,
    totalFlushUris: 0,
    totalMappings: 0,
    totalStoreWrites: 0,
    totalAcceptedWrites: 0,
    totalRejectedWrites: 0,
    totalOwnershipTransfers: 0,
    totalOwnershipDisputes: 0,
    totalStateAdds: 0,
    totalStateRemoves: 0,
    totalStateUpdates: 0,
    totalDuplicateDiagnostics: 0,
    totalAssertions: 0,
    mappingDurationSumUs: 0,
    writeDurationSumUs: 0,
    peakMappingDurationUs: 0,
    peakWriteDurationUs: 0,
  };

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly reporter: TelemetryReporter
  ) {
    /* Subscribe to raw VS Code diagnostics changes */
    this.disposables.push(
      languages.onDidChangeDiagnostics((e: DiagnosticChangeEvent) => {
        if (this.disposed) return;
        this.handleChangeEvent(e);
      })
    );

    /* Latch onto the vscodeDiagnostics provider when registered */
    const existing = this.manager.get('vscodeDiagnostics');
    if (existing) {
      this.attachToProvider(existing);
    }
    this.disposables.push(
      this.manager.onDidRegister((info) => {
        if (this.disposed) return;
        if (info.name === 'vscodeDiagnostics' && !this.vsDiagProvider) {
          this.attachToProvider(info.provider);
        }
      })
    );

    /* Subscribe to flush updates */
    this.disposables.push(
      this.manager.onDidUpdateAll((uris) => {
        if (this.disposed) return;
        this.handleFlushUpdates(uris);
      })
    );

    /* Subscribe to assertion failures from the runtime assertion system */
    this.disposables.push(
      this.reporter.subscribe('assertion.failure', (event) => {
        if (this.disposed) return;
        this.handleAssertionEvent(event as TelemetryEvent & { assertion: string; detail: string });
      })
    );

    /* Periodic performance snapshot */
    this.snapshotTimer = setInterval(() => {
      if (this.disposed) return;
      this.reportSnapshot();
    }, 60000);
  }

  /* ------------------------------------------------------------------ */
  /*  Diagnostics event handlers (Task 2)                                */
  /* ------------------------------------------------------------------ */

  private handleChangeEvent(e: DiagnosticChangeEvent): void {
    const traceId = generateTraceId();
    const nowMs = Date.now();
    const uris = e.uris.map((u: Uri) => u.toString());
    const event: DiagnosticsChangeEventData = {
      type: 'diagnostics.change',
      timestamp: nowMs,
      traceId,
      source: 'DiagnosticsMonitor',
      uriCount: uris.length,
      uris,
    };

    this.stats.totalChanges++;
    this.stats.totalUris += uris.length;

    /* Discard stale entries from provider-skipped URIs in prior cycles */
    this.mappingStartTimes.clear();
    this.activeMappings = 0;

    for (const uri of uris) {
      this.knownUris.add(uri);
      this.mappingStartTimes.set(uri, nowMs);
      this.activeMappings++;
    }

    this.reporter.report(event as TelemetryEvent);
  }

  private attachToProvider(provider: DiagnosticProvider): void {
    this.vsDiagProvider = provider;

    const store = provider.store;

    this.disposables.push(
      provider.onDidUpdate((uris: Uri[]) => {
        if (this.disposed) return;
        this.handleProviderUpdate(uris);
      })
    );

    this.disposables.push(
      store.onDidChange((change: ProblemStoreChange) => {
        if (this.disposed) return;
        /* Ignore events from stale store instances after provider re-registration */
        if (this.vsDiagProvider?.store !== store) return;
        this.handleStoreChange(change, store, provider.name);
      })
    );
  }

  private handleProviderUpdate(uris: Uri[]): void {
    for (const uri of uris) {
      const traceId = generateTraceId();
      const uriStr = uri.toString();
      const nowMs = Date.now();

      /* Compute mapping duration from change event to provider update */
      const startMs = this.mappingStartTimes.get(uriStr);
      this.mappingStartTimes.delete(uriStr);
      if (startMs !== undefined) {
        this.activeMappings--;
      }
      const mappingDurationUs = startMs !== undefined
        ? Math.round((nowMs - startMs) * 1000)
        : 0;

      /* Count raw VS Code diagnostics from the store's ProblemState */
      let diagnosticCount = 0;
      let errorCount = 0;
      let warningCount = 0;
      let infoCount = 0;

      const storeState = this.vsDiagProvider?.store?.get(uri);
      if (storeState) {
        errorCount = storeState.errorCount;
        warningCount = storeState.warningCount;
        infoCount = storeState.infoCount;
        diagnosticCount = errorCount + warningCount + infoCount;
      }

      const success = true;

      /* Update mapping duration statistics */
      if (mappingDurationUs > 0) {
        this.stats.mappingDurationSumUs += mappingDurationUs;
        if (mappingDurationUs > this.stats.peakMappingDurationUs) {
          this.stats.peakMappingDurationUs = mappingDurationUs;
        }
      }

      this.reporter.report({
        type: 'diagnostics.mapping',
        timestamp: nowMs,
        traceId,
        source: 'DiagnosticsMonitor',
        uri: uriStr,
        diagnosticCount,
        errorCount,
        warningCount,
        infoCount,
        mappingDurationUs,
        success,
      } as TelemetryEvent);

      this.stats.totalMappings++;

      /* Detect duplicate: when a higher-priority provider already owns this URI */
      const store = this.vsDiagProvider?.store;
      const currentOwner = store ? store.getOwningProvider(uri) : undefined;
      if (currentOwner && currentOwner !== 'vscodeDiagnostics') {
        this.reporter.report({
          type: 'diagnostics.storeWrite',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          provider: currentOwner,
          severity: ProblemSeverity.None,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          accepted: false,
          rejectReason: `owned by higher-priority provider '${currentOwner}'`,
          ownerAfter: currentOwner,
          writeDurationUs: 0,
        } as TelemetryEvent);
        this.stats.totalStoreWrites++;
        this.stats.totalRejectedWrites++;

        this.reporter.report({
          type: 'diagnostics.ownership',
          timestamp: nowMs,
          traceId,
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          provider: currentOwner,
          action: 'disputed',
        } as TelemetryEvent);
        this.stats.totalOwnershipDisputes++;

        this.reporter.report({
          type: 'diagnostics.stateChange',
          timestamp: nowMs,
          traceId,
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          change: 'duplicate',
          currentState: store?.get(uri),
          provider: currentOwner,
        } as TelemetryEvent);
        this.stats.totalDuplicateDiagnostics++;
      }
    }
  }

  private handleFlushUpdates(uris: Uri[]): void {
    const traceId = generateTraceId();
    this.stats.totalFlushUpdates++;
    this.stats.totalFlushUris += uris.length;
    for (const uri of uris) {
      const uriStr = uri.toString();
      this.knownUris.add(uriStr);
    }

    this.reporter.report({
      type: 'diagnostics.flush',
      timestamp: Date.now(),
      traceId,
      source: 'DiagnosticsMonitor',
      uriCount: uris.length,
      uris: uris.map((u: Uri) => u.toString()),
    } as TelemetryEvent);
  }

  /* ------------------------------------------------------------------ */
  /*  Runtime assertion handlers (Task 6)                                */
  /* ------------------------------------------------------------------ */

  private handleAssertionEvent(event: TelemetryEvent & { assertion: string; detail: string }): void {
    this.reporter.report({
      type: 'diagnostics.assertion',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      parentTraceId: event.traceId,
      source: 'DiagnosticsMonitor',
      assertion: event.assertion,
      detail: event.detail,
    } as TelemetryEvent);
    this.stats.totalAssertions++;
  }

  /* ------------------------------------------------------------------ */
  /*  Performance snapshot (Task 7)                                       */
  /* ------------------------------------------------------------------ */

  private reportSnapshot(): void {
    const snapshot = this.captureSnapshot();
    this.reporter.report({
      type: 'diagnostics.snapshot',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'DiagnosticsMonitor',
      statistics: snapshot.statistics,
    } as TelemetryEvent);
  }

  /* ------------------------------------------------------------------ */
  /*  Store event handlers (Task 4)                                      */
  /* ------------------------------------------------------------------ */

  private handleStoreChange(change: ProblemStoreChange, store: ProblemStore, providerName: string): void {
    switch (change.kind) {
      case 'added':
      case 'updated': {
        const uriStr = change.uri.toString();
        const nowMs = Date.now();

        /* Write duration = from raw change event to store write */
        const changeStartMs = this.mappingStartTimes.get(uriStr);
        this.mappingStartTimes.delete(uriStr);
        const writeDurationUs = changeStartMs !== undefined
          ? Math.round((nowMs - changeStartMs) * 1000)
          : 0;

        if (writeDurationUs > 0) {
          this.stats.writeDurationSumUs += writeDurationUs;
          if (writeDurationUs > this.stats.peakWriteDurationUs) {
            this.stats.peakWriteDurationUs = writeDurationUs;
          }
        }

        const state = store.get(change.uri);
        const ownerAfter = store.getOwningProvider(change.uri);

        this.reporter.report({
          type: 'diagnostics.storeWrite',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          provider: ownerAfter ?? providerName,
          severity: state?.severity ?? ProblemSeverity.None,
          errorCount: state?.errorCount ?? 0,
          warningCount: state?.warningCount ?? 0,
          infoCount: state?.infoCount ?? 0,
          accepted: true,
          ownerAfter,
          writeDurationUs,
        } as TelemetryEvent);

        this.reporter.report({
          type: 'diagnostics.stateChange',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          change: change.kind,
          currentState: state,
          provider: ownerAfter ?? providerName,
        } as TelemetryEvent);

        this.stats.totalStoreWrites++;
        this.stats.totalAcceptedWrites++;

        if (ownerAfter !== undefined && !this.knownUris.has(uriStr)) {
          /* First ownership seen — URI not previously tracked */
          this.reporter.report({
            type: 'diagnostics.ownership',
            timestamp: nowMs,
            traceId: generateTraceId(),
            source: 'DiagnosticsMonitor',
            uri: uriStr,
            provider: ownerAfter,
            action: 'acquired',
          } as TelemetryEvent);
        } else if (ownerAfter !== undefined && this.knownUris.has(uriStr)) {
          /* Ownership already tracked — URI was previously seen */
        }

        if (change.kind === 'added') {
          this.stats.totalStateAdds++;
        } else {
          this.stats.totalStateUpdates++;
        }
        break;
      }

      case 'removed': {
        const uriStr = change.uri.toString();
        const nowMs = Date.now();

        const changeStartMs = this.mappingStartTimes.get(uriStr);
        this.mappingStartTimes.delete(uriStr);
        const writeDurationUs = changeStartMs !== undefined
          ? Math.round((nowMs - changeStartMs) * 1000)
          : 0;

        if (writeDurationUs > 0) {
          this.stats.writeDurationSumUs += writeDurationUs;
          if (writeDurationUs > this.stats.peakWriteDurationUs) {
            this.stats.peakWriteDurationUs = writeDurationUs;
          }
        }

        this.reporter.report({
          type: 'diagnostics.storeWrite',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          provider: providerName,
          severity: ProblemSeverity.None,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          accepted: true,
          writeDurationUs,
        } as TelemetryEvent);

        this.reporter.report({
          type: 'diagnostics.stateChange',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          change: 'removed',
          currentState: undefined,
          provider: providerName,
        } as TelemetryEvent);

        this.stats.totalStoreWrites++;
        this.stats.totalAcceptedWrites++;
        this.stats.totalStateRemoves++;

        this.reporter.report({
          type: 'diagnostics.ownership',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          provider: providerName,
          action: 'released',
        } as TelemetryEvent);
        break;
      }

      case 'cleared': {
        this.knownUris.clear();
        this.mappingStartTimes.clear();
        break;
      }

      case 'batch': {
        /* Batches are internal to the store; no monitor action needed */
        break;
      }

      case 'prefixDeleted': {
        const prefix = change.prefix;
        const filter = (key: string) => key.startsWith(prefix);
        for (const key of this.knownUris) { if (filter(key)) this.knownUris.delete(key); }
        for (const key of this.mappingStartTimes.keys()) { if (filter(key)) this.mappingStartTimes.delete(key); }
        break;
      }

      case 'prefixMoved': {
        const { oldPrefix, newPrefix } = change;
        const remap = (key: string) =>
          key.startsWith(oldPrefix) ? newPrefix + key.slice(oldPrefix.length) : key;

        /* Remap knownUris */
        const urisToMove: string[] = [];
        for (const key of this.knownUris) {
          if (key.startsWith(oldPrefix)) urisToMove.push(key);
        }
        for (const key of urisToMove) {
          this.knownUris.delete(key);
          this.knownUris.add(remap(key));
        }

        /* Remap mappingStartTimes */
        const timesToMove: Array<[string, number]> = [];
        for (const [key, val] of this.mappingStartTimes) {
          if (key.startsWith(oldPrefix)) timesToMove.push([key, val]);
        }
        for (const [key, val] of timesToMove) {
          this.mappingStartTimes.delete(key);
          this.mappingStartTimes.set(remap(key), val);
        }
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  getStatistics(): DiagnosticsStatistics {
    return { ...this.stats };
  }

  captureSnapshot(): DiagnosticsSnapshot {
    return {
      activeMappings: this.activeMappings,
      pendingWrites: this.pendingWrites,
      statistics: this.getStatistics(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.snapshotTimer !== undefined) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.knownUris.clear();
    this.mappingStartTimes.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createDiagnosticsMonitor(
  manager: DiagnosticProviderManager,
  reporter: TelemetryReporter
): DiagnosticsMonitor {
  return new DiagnosticsMonitor(manager, reporter);
}
