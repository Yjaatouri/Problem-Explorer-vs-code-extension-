import { Uri, Disposable, workspace } from 'vscode';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemState, ProblemSeverity } from '../../core/types';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { generateTraceId } from '../../telemetry/TelemetryConfig';
import { normalizeUriKey, getParentKey } from '../../core/uriKey';

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
  private readonly originalSetFolderAggregate: (uri: Uri, state: ProblemState) => boolean;
  private readonly originalStoreDelete: (uri: Uri) => boolean;

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
    this.originalSetFolderAggregate = problemStore.setFolderAggregate.bind(problemStore);
    this.originalStoreDelete = problemStore.delete.bind(problemStore);

    this.wrapUpdateAncestors();
    this.wrapRebuildAll();
    this.wrapRecomputeFolderStatus();
    this.wrapSetFolderAggregate();
    this.wrapStoreDelete();
  }

  /* ------------------------------------------------------------------ */
  /*  Method wrapping                                                     */
  /* ------------------------------------------------------------------ */

  private computeAncestorChain(fileUriStr: string): { ancestors: string[]; rootStr: string } {
    const ancestors: string[] = [];
    const rootStr = normalizeUriKey(workspace.workspaceFolders?.[0]?.uri ?? Uri.parse('/'));
    let parentKey = getParentKey(fileUriStr);
    let childKey = fileUriStr;

    /* Walk from the file's parent up to the workspace root */
    while (parentKey !== childKey && parentKey !== rootStr) {
      ancestors.push(parentKey);
      childKey = parentKey;
      parentKey = getParentKey(childKey);
    }

    /* Add root */
    ancestors.push(rootStr);

    return { ancestors, rootStr };
  }

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

      /* Compute ancestor chain before the call */
      const { ancestors, rootStr } = self.computeAncestorChain(uriStr);

      const changed = self.originalUpdateAncestors(fileUri);
      const durationMs = Date.now() - start;
      const changedUris = changed.map((u: Uri) => u.toString());

      /* Determine which ancestors were updated vs skipped */
      const changedSet = new Set(changedUris);
      const foldersSkipped = ancestors.filter((a) => !changedSet.has(a));
      const foldersUpdated = ancestors.filter((a) => changedSet.has(a));
      const traversalDepth = ancestors.length;
      self.stats.totalFoldersSkipped += foldersSkipped.length;
      self.stats.totalAncestorsTraversed += traversalDepth;

      /* Estimate depth from URI path segments */
      const segments = uriStr.split('/').filter(Boolean);
      const depth = segments.length;

      self.stats.totalUpdateAncestors++;
      self.stats.totalFoldersChanged += changed.length;
      self.stats.updateAncestorsDurationSumMs += durationMs;
      if (durationMs > self.stats.peakUpdateAncestorsDurationMs) {
        self.stats.peakUpdateAncestorsDurationMs = durationMs;
      }

      if (traversalDepth > self.stats.peakPropagationDepth) {
        self.stats.peakPropagationDepth = traversalDepth;
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

      /* Emit propagation event with full ancestor chain */
      self.reporter.report({
        type: 'folder.propagation',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        fileUri: uriStr,
        ancestorChain: ancestors,
        foldersUpdated,
        foldersSkipped,
        traversalDepth,
        rootUri: rootStr,
        durationMs,
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
  /*  Store wrapping for aggregate tracking (Task 3)                      */
  /* ------------------------------------------------------------------ */

  private emitAggregateEvent(uriStr: string, action: 'created' | 'updated' | 'removed' | 'unchanged', before?: ProblemState, after?: ProblemState): void {
    const errorDelta = (after?.errorCount ?? 0) - (before?.errorCount ?? 0);
    const warningDelta = (after?.warningCount ?? 0) - (before?.warningCount ?? 0);
    const infoDelta = (after?.infoCount ?? 0) - (before?.infoCount ?? 0);

    switch (action) {
      case 'created': this.stats.totalAggregatesCreated++; break;
      case 'updated': this.stats.totalAggregatesUpdated++; break;
      case 'removed': this.stats.totalAggregatesRemoved++; break;
      case 'unchanged': this.stats.totalAggregatesUnchanged++; break;
    }

    this.reporter.report({
      type: 'folder.aggregate',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'FolderMonitor',
      uri: uriStr,
      action,
      aggregateBefore: before,
      aggregateAfter: after,
      errorDelta,
      warningDelta,
      infoDelta,
      severityBefore: before?.severity,
      severityAfter: after?.severity,
      childCount: after?.fileCount ?? before?.fileCount ?? 0,
    } as any);
  }

  private wrapSetFolderAggregate(): void {
    const self = this;
    this.problemStore.setFolderAggregate = function (uri: Uri, state: ProblemState): boolean {
      if (self.disposed) return self.originalSetFolderAggregate(uri, state);
      const before = self.problemStore.get(uri);
      const accepted = self.originalSetFolderAggregate(uri, state);
      const after = self.problemStore.get(uri);
      const uriStr = uri.toString();

      if (accepted) {
        if (!before) {
          self.emitAggregateEvent(uriStr, 'created', before, after);
        } else {
          self.emitAggregateEvent(uriStr, 'updated', before, after);
        }
        self.stats.totalStoreWrites++;
        self.stats.totalStoreWritesAccepted++;
      } else {
        self.emitAggregateEvent(uriStr, 'unchanged', before, after);
        self.stats.totalStoreWrites++;
        self.stats.totalStoreWritesRejected++;
      }
      return accepted;
    };
  }

  private wrapStoreDelete(): void {
    const self = this;
    this.problemStore.delete = function (uri: Uri): boolean {
      if (self.disposed) return self.originalStoreDelete(uri);
      const uriStr = uri.toString();
      const isFolder = self.problemStore.isFolderAggregate(uri);
      const before = isFolder ? self.problemStore.get(uri) : undefined;
      const result = self.originalStoreDelete(uri);

      if (isFolder && result && before) {
        self.emitAggregateEvent(uriStr, 'removed', before, undefined);
      }
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
    this.problemStore.setFolderAggregate = this.originalSetFolderAggregate;
    this.problemStore.delete = this.originalStoreDelete;
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
