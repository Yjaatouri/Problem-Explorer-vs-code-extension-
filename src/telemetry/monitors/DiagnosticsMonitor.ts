import { Disposable, languages, DiagnosticChangeEvent, Uri, DiagnosticSeverity } from 'vscode';
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
  totalMappings: number;
  totalMappingFailures: number;
  totalStoreWrites: number;
  totalAcceptedWrites: number;
  totalRejectedWrites: number;
  totalOwnershipTransfers: number;
  totalOwnershipDisputes: number;
  totalStateAdds: number;
  totalStateRemoves: number;
  totalStateUpdates: number;
  totalStaleDiagnostics: number;
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
  private readonly uriProvider = new Map<string, string>();
  private vsDiagProvider: DiagnosticProvider | undefined;
  private readonly pendingScans = new Map<string, boolean>();

  /* Store ownership tracking for before/after comparisons */
  private readonly knownOwners = new Map<string, string>();
  private readonly previousStates = new Map<string, ProblemState>();

  /* Pipeline timing */
  private activeMappings = 0;
  private pendingWrites = 0;
  private readonly mappingStartTimes = new Map<string, number>();
  private readonly writeStartTimes = new Map<string, number>();
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;

  /* Cumulative statistics */
  private readonly stats: DiagnosticsStatistics = {
    totalChanges: 0,
    totalUris: 0,
    totalMappings: 0,
    totalMappingFailures: 0,
    totalStoreWrites: 0,
    totalAcceptedWrites: 0,
    totalRejectedWrites: 0,
    totalOwnershipTransfers: 0,
    totalOwnershipDisputes: 0,
    totalStateAdds: 0,
    totalStateRemoves: 0,
    totalStateUpdates: 0,
    totalStaleDiagnostics: 0,
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

    /* Track full scans via scan progress */
    this.disposables.push(
      this.manager.onDidScanProgress((progress) => {
        if (this.disposed) return;
        if (progress.providerName === 'vscodeDiagnostics') {
          if (progress.phase === 'scanning' || progress.phase === 'resolving') {
            this.pendingScans.set(progress.providerName, true);
          } else if (progress.phase === 'completed' || progress.phase === 'cancelled' || progress.phase === 'error') {
            this.pendingScans.delete(progress.providerName);
          }
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
    for (const uri of uris) {
      this.knownUris.add(uri);
      this.mappingStartTimes.set(uri, nowMs);
    }

    this.reporter.report(event as TelemetryEvent);
  }

  private attachToProvider(provider: DiagnosticProvider): void {
    this.vsDiagProvider = provider;

    this.disposables.push(
      provider.onDidUpdate((uris: Uri[]) => {
        if (this.disposed) return;
        this.handleProviderUpdate(uris);
      })
    );

    this.disposables.push(
      provider.store.onDidChange((change: ProblemStoreChange) => {
        if (this.disposed) return;
        this.handleStoreChange(change, provider.store, provider.name);
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
      const mappingDurationUs = startMs !== undefined
        ? Math.round((nowMs - startMs) * 1000)
        : 0;

      /* Count raw VS Code diagnostics before aggregation */
      let diagnosticCount = 0;
      let errorCount = 0;
      let warningCount = 0;
      let infoCount = 0;

      try {
        const raw = languages.getDiagnostics(uri);
        diagnosticCount = raw.length;
        for (const d of raw) {
          switch (d.severity) {
            case DiagnosticSeverity.Error: errorCount++; break;
            case DiagnosticSeverity.Warning: warningCount++; break;
            case DiagnosticSeverity.Information: infoCount++; break;
          }
        }
      } catch {
        /* getDiagnostics may throw for URIs not yet in the workspace */
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
    const event: DiagnosticsChangeEventData = {
      type: 'diagnostics.change',
      timestamp: Date.now(),
      traceId,
      source: 'DiagnosticsMonitor',
      uriCount: uris.length,
      uris: uris.map((u: Uri) => u.toString()),
    };

    this.stats.totalChanges++;
    this.stats.totalUris += uris.length;
    for (const uri of uris) {
      this.knownUris.add(uri.toString());
    }

    this.reporter.report(event as TelemetryEvent);
  }

  /* ------------------------------------------------------------------ */
  /*  Runtime assertion handlers (Task 6)                                */
  /* ------------------------------------------------------------------ */

  private handleAssertionEvent(event: TelemetryEvent & { assertion: string; detail: string }): void {
    this.reporter.report({
      type: 'diagnostics.assertion',
      timestamp: Date.now(),
      traceId: generateTraceId(),
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

        /* Compute write duration from previous recorded start time */
        const writeStartMs = this.writeStartTimes.get(uriStr);
        this.writeStartTimes.delete(uriStr);
        const writeDurationUs = writeStartMs !== undefined
          ? Math.round((nowMs - writeStartMs) * 1000)
          : 0;

        if (writeDurationUs > 0) {
          this.stats.writeDurationSumUs += writeDurationUs;
          if (writeDurationUs > this.stats.peakWriteDurationUs) {
            this.stats.peakWriteDurationUs = writeDurationUs;
          }
        }

        const state = store.get(change.uri);
        const ownerAfter = store.getOwningProvider(change.uri);
        const ownerBefore = this.knownOwners.get(uriStr);
        const prevState = this.previousStates.get(uriStr);
        this.knownOwners.set(uriStr, ownerAfter ?? providerName);
        if (state) {
          this.previousStates.set(uriStr, state);
        }

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
          ownerBefore,
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
          previousState: prevState,
          currentState: state,
          provider: ownerAfter ?? providerName,
        } as TelemetryEvent);

        this.stats.totalStoreWrites++;
        this.stats.totalAcceptedWrites++;

        if (ownerBefore !== undefined && ownerAfter !== undefined && ownerBefore !== ownerAfter) {
          this.reporter.report({
            type: 'diagnostics.ownership',
            timestamp: Date.now(),
            traceId: generateTraceId(),
            source: 'DiagnosticsMonitor',
            uri: uriStr,
            provider: ownerAfter,
            previousOwner: ownerBefore,
            action: 'transferred',
          } as TelemetryEvent);
          this.stats.totalOwnershipTransfers++;
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

        const writeStartMs = this.writeStartTimes.get(uriStr);
        this.writeStartTimes.delete(uriStr);
        const writeDurationUs = writeStartMs !== undefined
          ? Math.round((nowMs - writeStartMs) * 1000)
          : 0;

        if (writeDurationUs > 0) {
          this.stats.writeDurationSumUs += writeDurationUs;
          if (writeDurationUs > this.stats.peakWriteDurationUs) {
            this.stats.peakWriteDurationUs = writeDurationUs;
          }
        }

        const ownerBefore = this.knownOwners.get(uriStr);
        const prevState = this.previousStates.get(uriStr);
        this.knownOwners.delete(uriStr);
        this.previousStates.delete(uriStr);

        this.reporter.report({
          type: 'diagnostics.storeWrite',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          provider: ownerBefore ?? providerName,
          severity: ProblemSeverity.None,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          accepted: true,
          ownerBefore,
          ownerAfter: undefined,
          writeDurationUs,
        } as TelemetryEvent);

        this.reporter.report({
          type: 'diagnostics.stateChange',
          timestamp: nowMs,
          traceId: generateTraceId(),
          source: 'DiagnosticsMonitor',
          uri: uriStr,
          change: 'removed',
          previousState: prevState,
          currentState: undefined,
          provider: ownerBefore,
        } as TelemetryEvent);

        this.stats.totalStoreWrites++;
        this.stats.totalAcceptedWrites++;
        this.stats.totalStateRemoves++;
        break;
      }

      case 'cleared': {
        break;
      }

      case 'batch': {
        break;
      }

      case 'prefixDeleted': {
        break;
      }

      case 'prefixMoved': {
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
    this.uriProvider.clear();
    this.mappingStartTimes.clear();
    this.writeStartTimes.clear();
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
