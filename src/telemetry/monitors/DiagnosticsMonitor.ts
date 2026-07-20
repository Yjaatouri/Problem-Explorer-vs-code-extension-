import { Disposable } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { TelemetryReporter } from '../../telemetry';
import { TraceId } from '../../telemetry';
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

  /* Pipeline timing */
  private activeMappings = 0;
  private pendingWrites = 0;

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

  constructor() {
    /* Dependencies and subscriptions set up in Task 2+ */
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
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.knownUris.clear();
    this.uriProvider.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createDiagnosticsMonitor(
  _manager: DiagnosticProviderManager,
  _reporter: TelemetryReporter
): DiagnosticsMonitor {
  return new DiagnosticsMonitor();
}
