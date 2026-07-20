import { Uri, Disposable } from 'vscode';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemState, ProblemSeverity } from '../../core/types';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

/** Trigger: rebuildAll() was started */
export interface FolderRebuildAllStartEventData {
  readonly type: 'folder.rebuildAll.start';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly indexSizeBefore: number;
}

/** Trigger: rebuildAll() was executed */
export interface FolderRebuildAllEventData {
  readonly type: 'folder.rebuildAll';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly durationMs: number;
  readonly executionTimeMs: number;
  readonly affectedCount: number;
  readonly affectedUris: string[];
  readonly workspaceFolders: number;
  readonly indexSizeBefore: number;
  readonly indexSizeAfter: number;
}

/** Trigger: updateAncestors() was started */
export interface FolderUpdateAncestorsStartEventData {
  readonly type: 'folder.updateAncestors.start';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly uri: string;
  readonly indexSizeBefore: number;
}

/** Trigger: updateAncestors() was executed */
export interface FolderUpdateAncestorsEventData {
  readonly type: 'folder.updateAncestors';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly uri: string;
  readonly changedCount: number;
  readonly changedUris: string[];
  readonly executionTimeMs: number;
  readonly durationMs: number;
  readonly depth: number;
  readonly indexSizeBefore: number;
  readonly indexSizeAfter: number;
}

/** Trigger: recomputeFolderStatus() was executed */
export interface FolderRecomputeEventData {
  readonly type: 'folder.recompute';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly uri: string;
  readonly children: number;
  readonly aggregateBefore?: ProblemState;
  readonly aggregateAfter: ProblemState;
  readonly executionTimeMs: number;
}

/** Trigger: a folder aggregate was created, updated, removed, or unchanged */
export interface FolderAggregateEventData {
  readonly type: 'folder.aggregate';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly uri: string;
  readonly action: 'created' | 'updated' | 'removed' | 'unchanged';
  readonly aggregateBefore?: ProblemState;
  readonly aggregateAfter?: ProblemState;
  readonly errorDelta: number;
  readonly warningDelta: number;
  readonly infoDelta: number;
  readonly severityBefore?: ProblemSeverity;
  readonly severityAfter?: ProblemSeverity;
  readonly childCount: number;
  readonly parentUri?: string;
}

/** Trigger: a file change propagated through ancestor chain */
export interface FolderPropagationEventData {
  readonly type: 'folder.propagation';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly fileUri: string;
  readonly ancestorChain: string[];
  readonly foldersUpdated: string[];
  readonly foldersSkipped: string[];
  readonly traversalDepth: number;
  readonly rootUri: string;
  readonly durationMs: number;
}

/** Trigger: folder aggregate was written to or rejected by ProblemStore */
export interface FolderStoreWriteEventData {
  readonly type: 'folder.storeWrite';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly uri: string;
  readonly accepted: boolean;
  readonly rejectReason?: string;
  readonly aggregateBefore?: ProblemState;
  readonly aggregateAfter?: ProblemState;
  readonly isNew: boolean;
  readonly durationMs: number;
}

/** Trigger: assertion failure detected by FolderMonitor */
export interface FolderAssertionEventData {
  readonly type: 'folder.assertion';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'FolderMonitor';
  readonly code: string;
  readonly message: string;
  readonly uri?: string;
  readonly detail?: string;
}

/* ------------------------------------------------------------------ */
/*  Union type                                                         */
/* ------------------------------------------------------------------ */

export type FolderTelemetryEvent =
  | FolderRebuildAllStartEventData
  | FolderRebuildAllEventData
  | FolderUpdateAncestorsStartEventData
  | FolderUpdateAncestorsEventData
  | FolderRecomputeEventData
  | FolderAggregateEventData
  | FolderPropagationEventData
  | FolderStoreWriteEventData
  | FolderAssertionEventData;

/* ------------------------------------------------------------------ */
/*  Statistics & snapshot interfaces                                   */
/* ------------------------------------------------------------------ */

/** Cumulative folder aggregation statistics for a single cycle */
export interface FolderStatistics {
  totalRebuilds: number;
  totalUpdateAncestors: number;
  totalRecomputes: number;
  totalAggregatesCreated: number;
  totalAggregatesUpdated: number;
  totalAggregatesRemoved: number;
  totalAggregatesUnchanged: number;
  totalFoldersChanged: number;
  totalFoldersSkipped: number;
  totalAncestorsTraversed: number;
  totalStoreWrites: number;
  totalStoreWritesAccepted: number;
  totalStoreWritesRejected: number;
  totalAssertions: number;
  rebuildDurationSumMs: number;
  updateAncestorsDurationSumMs: number;
  recomputeDurationSumMs: number;
  peakRebuildDurationMs: number;
  peakUpdateAncestorsDurationMs: number;
  peakPropagationDepth: number;
  averagePropagationDepth: number;
}

/** Point-in-time snapshot of folder monitor state */
export interface FolderSnapshot {
  activeUpdates: number;
  activeRebuilds: number;
  indexSize: number;
  aggregateCount: number;
  statistics: FolderStatistics;
}

/* ------------------------------------------------------------------ */
/*  Monitor implementation                                             */
/* ------------------------------------------------------------------ */

/** Monitors FolderStatusManager by wrapping its aggregation methods */
export class FolderMonitor {
  private disposed = false;
  private readonly disposables: Disposable[] = [];

  /* Original method references for restoration */
  private readonly originalUpdateAncestors: (fileUri: Uri) => Uri[];
  private readonly originalRebuildAll: () => Uri[];
  private readonly originalRecomputeFolderStatus: (folderUri: Uri) => ProblemState;

  /* Concurrency tracking */
  private activeUpdates = 0;
  private activeRebuilds = 0;

  /* Cumulative statistics */
  private readonly stats: FolderStatistics = {
    totalRebuilds: 0,
    totalUpdateAncestors: 0,
    totalRecomputes: 0,
    totalAggregatesCreated: 0,
    totalAggregatesUpdated: 0,
    totalAggregatesRemoved: 0,
    totalAggregatesUnchanged: 0,
    totalFoldersChanged: 0,
    totalFoldersSkipped: 0,
    totalAncestorsTraversed: 0,
    totalStoreWrites: 0,
    totalStoreWritesAccepted: 0,
    totalStoreWritesRejected: 0,
    totalAssertions: 0,
    rebuildDurationSumMs: 0,
    updateAncestorsDurationSumMs: 0,
    recomputeDurationSumMs: 0,
    peakRebuildDurationMs: 0,
    peakUpdateAncestorsDurationMs: 0,
    peakPropagationDepth: 0,
    averagePropagationDepth: 0,
  };

  constructor(
    private readonly folderManager: FolderStatusManager,
    private readonly problemStore: ProblemStore,
    private readonly reporter: TelemetryReporter
  ) {
    this.originalUpdateAncestors = folderManager.updateAncestors.bind(folderManager);
    this.originalRebuildAll = folderManager.rebuildAll.bind(folderManager);
    this.originalRecomputeFolderStatus = folderManager.recomputeFolderStatus.bind(folderManager);

    this.wrapUpdateAncestors();
    this.wrapRebuildAll();
    this.wrapRecomputeFolderStatus();
  }

  /* ------------------------------------------------------------------ */
  /*  Method wrapping                                                     */
  /* ------------------------------------------------------------------ */

  private wrapUpdateAncestors(): void {
    const self = this;
    this.folderManager.updateAncestors = function (fileUri: Uri): Uri[] {
      if (self.disposed) return self.originalUpdateAncestors(fileUri);
      self.activeUpdates++;
      const start = Date.now();
      const uriStr = fileUri.toString();
      const indexBefore = self.folderManager.childIndexSize;

      /* Emit start event */
      self.reporter.report({
        type: 'folder.updateAncestors.start',
        timestamp: start,
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        uri: uriStr,
        indexSizeBefore: indexBefore,
      } as any);

      const changed = self.originalUpdateAncestors(fileUri);
      const durationMs = Date.now() - start;
      const changedUris = changed.map((u: Uri) => u.toString());

      /* Estimate depth from URI path segments */
      const segments = uriStr.split('/').filter(Boolean);
      const depth = segments.length;

      self.stats.totalUpdateAncestors++;
      self.stats.totalFoldersChanged += changed.length;
      self.stats.updateAncestorsDurationSumMs += durationMs;
      if (durationMs > self.stats.peakUpdateAncestorsDurationMs) {
        self.stats.peakUpdateAncestorsDurationMs = durationMs;
      }

      self.reporter.report({
        type: 'folder.updateAncestors',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        uri: uriStr,
        changedCount: changed.length,
        changedUris,
        executionTimeMs: durationMs,
        durationMs,
        depth,
        indexSizeBefore: indexBefore,
        indexSizeAfter: self.folderManager.childIndexSize,
      } as any);

      self.activeUpdates--;
      return changed;
    };
  }

  private wrapRebuildAll(): void {
    const self = this;
    this.folderManager.rebuildAll = function (): Uri[] {
      if (self.disposed) return self.originalRebuildAll();
      self.activeRebuilds++;
      const start = Date.now();
      const indexSizeBefore = self.folderManager.childIndexSize;

      /* Emit start event */
      self.reporter.report({
        type: 'folder.rebuildAll.start',
        timestamp: start,
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        indexSizeBefore,
      } as any);

      const changed = self.originalRebuildAll();
      const durationMs = Date.now() - start;
      const changedUris = changed.map((u: Uri) => u.toString());

      self.stats.totalRebuilds++;
      self.stats.rebuildDurationSumMs += durationMs;
      if (durationMs > self.stats.peakRebuildDurationMs) {
        self.stats.peakRebuildDurationMs = durationMs;
      }

      self.reporter.report({
        type: 'folder.rebuildAll',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        durationMs,
        executionTimeMs: durationMs,
        affectedCount: changed.length,
        affectedUris: changedUris,
        workspaceFolders: 0,
        indexSizeBefore,
        indexSizeAfter: self.folderManager.childIndexSize,
      } as any);

      self.activeRebuilds--;
      return changed;
    };
  }

  private wrapRecomputeFolderStatus(): void {
    const self = this;
    this.folderManager.recomputeFolderStatus = function (folderUri: Uri): ProblemState {
      if (self.disposed) return self.originalRecomputeFolderStatus(folderUri);
      const start = Date.now();
      const uriStr = folderUri.toString();
      const aggregateBefore = self.problemStore.get(folderUri);
      const result = self.originalRecomputeFolderStatus(folderUri);
      const durationMs = Date.now() - start;

      self.stats.totalRecomputes++;
      self.stats.recomputeDurationSumMs += durationMs;

      self.reporter.report({
        type: 'folder.recompute',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        uri: uriStr,
        children: result.fileCount,
        aggregateBefore,
        aggregateAfter: result,
        executionTimeMs: durationMs,
      } as any);

      return result;
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Snapshot                                                            */
  /* ------------------------------------------------------------------ */

  /** Capture a point-in-time snapshot of the monitor's state */
  captureSnapshot(): FolderSnapshot {
    return {
      activeUpdates: this.activeUpdates,
      activeRebuilds: this.activeRebuilds,
      indexSize: this.folderManager.childIndexSize,
      aggregateCount: 0,
      statistics: { ...this.stats },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Statistics                                                          */
  /* ------------------------------------------------------------------ */

  /** Get cumulative statistics */
  getStatistics(): FolderStatistics {
    return { ...this.stats };
  }

  /* ------------------------------------------------------------------ */
  /*  Dispose                                                             */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.folderManager.updateAncestors = this.originalUpdateAncestors;
    this.folderManager.rebuildAll = this.originalRebuildAll;
    this.folderManager.recomputeFolderStatus = this.originalRecomputeFolderStatus;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Create a FolderMonitor attached to the given FolderStatusManager and reporter */
export function createFolderMonitor(
  folderManager: FolderStatusManager,
  problemStore: ProblemStore,
  reporter: TelemetryReporter
): FolderMonitor {
  return new FolderMonitor(folderManager, problemStore, reporter);
}
