import { Uri, workspace } from 'vscode';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemState } from '../../core/types';
import type { ProblemSeverity } from '../../core/types';
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
  readonly workspaceFolders: number;
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
  readonly owner?: string;
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
  totalFoldersProcessed: number;
  totalAncestorsTraversed: number;
  totalStoreWrites: number;
  totalStoreWritesAccepted: number;
  totalStoreWritesRejected: number;
  totalAssertions: number;
  rebuildDurationSumMs: number;
  updateAncestorsDurationSumMs: number;
  recomputeDurationSumMs: number;
  propagationDepthSum: number;
  peakRebuildDurationMs: number;
  peakUpdateAncestorsDurationMs: number;
  peakPropagationDepth: number;
  averageRebuildDurationMs: number;
  averageUpdateAncestorsDurationMs: number;
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

  /* Original method references for restoration */
  private readonly originalUpdateAncestors: (fileUri: Uri) => Uri[];
  private readonly originalRebuildAll: () => Uri[];
  private readonly originalRecomputeFolderStatus: (folderUri: Uri) => ProblemState;
  private readonly originalSetFolderAggregate: (uri: Uri, state: ProblemState) => boolean;
  private readonly originalStoreDelete: (uri: Uri) => boolean;

  /* Concurrency tracking */
  private activeUpdates = 0;
  private activeRebuilds = 0;

  /* Rebuild consistency tracking */
  private lastRebuildChangedUris: string[] | undefined;

  /* Reentrancy guard for store wrappers */
  private reentrant = 0;

  /* Live aggregate count */
  private aggregateCount = 0;

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
    totalFoldersProcessed: 0,
    totalAncestorsTraversed: 0,
    totalStoreWrites: 0,
    totalStoreWritesAccepted: 0,
    totalStoreWritesRejected: 0,
    totalAssertions: 0,
    rebuildDurationSumMs: 0,
    updateAncestorsDurationSumMs: 0,
    recomputeDurationSumMs: 0,
    propagationDepthSum: 0,
    peakRebuildDurationMs: 0,
    peakUpdateAncestorsDurationMs: 0,
    peakPropagationDepth: 0,
    averageRebuildDurationMs: 0,
    averageUpdateAncestorsDurationMs: 0,
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
    const fileUri = Uri.parse(fileUriStr);
    const wf = workspace.getWorkspaceFolder(fileUri);
    if (!wf) {
      return { ancestors: [], rootStr: '' };
    }
    const rootStr = normalizeUriKey(wf.uri);
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
    this.folderManager.updateAncestors = (fileUri: Uri): Uri[] => {
      if (this.disposed) return this.originalUpdateAncestors(fileUri);
      this.activeUpdates++;
      try {
        const start = Date.now();
        const uriStr = fileUri.toString();
        const indexBefore = this.folderManager.childIndexSize;

      /* Emit start event (non-critical — wrap in try to avoid blocking original) */
      try {
        this.reporter.report({
          type: 'folder.updateAncestors.start',
          timestamp: start,
          traceId: generateTraceId(),
          source: 'FolderMonitor',
          uri: uriStr,
          indexSizeBefore: indexBefore,
        } as any);
      } catch { /* monitoring only */ }

      /* Compute ancestor chain before the call */
      const { ancestors, rootStr } = this.computeAncestorChain(uriStr);

      const changed = this.originalUpdateAncestors(fileUri);
      const now = Date.now();
      const durationMs = now - start;
      const changedUris = changed.map((u: Uri) => u.toString());
      const propagationStart = Date.now();

      /* Determine which ancestors were updated vs skipped */
      const changedSet = new Set(changedUris);
      const foldersSkipped = ancestors.filter((a) => !changedSet.has(a));
      const foldersUpdated = ancestors.filter((a) => changedSet.has(a));
      const traversalDepth = ancestors.length;
      this.stats.totalFoldersSkipped += foldersSkipped.length;
      this.stats.totalAncestorsTraversed += traversalDepth;
      this.stats.propagationDepthSum += traversalDepth;
      this.stats.totalFoldersProcessed += changed.length;

      /* Estimate depth from URI path segments */
      const segments = uriStr.split('/').filter(Boolean);
      const depth = segments.length;

      this.stats.totalUpdateAncestors++;
      this.stats.totalFoldersChanged += changed.length;
      this.stats.updateAncestorsDurationSumMs += durationMs;
      if (durationMs > this.stats.peakUpdateAncestorsDurationMs) {
        this.stats.peakUpdateAncestorsDurationMs = durationMs;
      }

      if (traversalDepth > this.stats.peakPropagationDepth) {
        this.stats.peakPropagationDepth = traversalDepth;
      }

      this.reporter.report({
        type: 'folder.updateAncestors',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        uri: uriStr,
        changedCount: changed.length,
        changedUris,
        executionTimeMs: durationMs,
        durationMs,
        depth,
        indexSizeBefore: indexBefore,
        indexSizeAfter: this.folderManager.childIndexSize,
      } as any);

      /* Emit propagation event with full ancestor chain */
      const propagationMs = Date.now() - propagationStart;
      this.reporter.report({
        type: 'folder.propagation',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        fileUri: uriStr,
        ancestorChain: ancestors,
        foldersUpdated,
        foldersSkipped,
        traversalDepth,
        rootUri: rootStr,
        durationMs: propagationMs,
      } as any);

      /* Check skipped ancestors for stale aggregates (Task 5) */
      for (const skipped of foldersSkipped) {
        this.checkStaleAggregate(Uri.parse(skipped));
      }

      /* Runtime assertions (Task 6) */
      this.checkMissingAncestorUpdate(changedUris, ancestors, uriStr);
      this.checkDuplicateFolderUpdate(changedUris, uriStr);
      for (const updated of changedUris) {
        this.checkOrphanFolder(Uri.parse(updated));
      }

      /* Check rebuild consistency: an aggregate updated here should match the last rebuild */
      if (this.lastRebuildChangedUris) {
        for (const changedUri of changedUris) {
          if (!this.lastRebuildChangedUris.includes(changedUri)) {
            this.emitAssertion('REBUILD_INCONSISTENCY',
              `Folder ${changedUri} was updated by updateAncestors but not by last rebuildAll`,
              changedUri, `rebuildAffected=[${this.lastRebuildChangedUris.join(',')}]`);
          }
        }
        this.lastRebuildChangedUris = undefined;
      }

      return changed;
      } finally {
        this.activeUpdates--;
      }
    };
  }

  private wrapRebuildAll(): void {
    this.folderManager.rebuildAll = (): Uri[] => {
      if (this.disposed) return this.originalRebuildAll();
      this.activeRebuilds++;
      try {
        const start = Date.now();
        const indexSizeBefore = this.folderManager.childIndexSize;

      /* Emit start event (non-critical — wrap in try to avoid blocking original) */
      try {
        this.reporter.report({
          type: 'folder.rebuildAll.start',
          timestamp: start,
          traceId: generateTraceId(),
          source: 'FolderMonitor',
          indexSizeBefore,
          workspaceFolders: workspace.workspaceFolders?.length ?? 0,
        } as any);
      } catch { /* monitoring only */ }

      const changed = this.originalRebuildAll();
      const now = Date.now();
      const durationMs = now - start;
      const changedUris = changed.map((u: Uri) => u.toString());

      this.stats.totalRebuilds++;
      this.stats.rebuildDurationSumMs += durationMs;
      if (durationMs > this.stats.peakRebuildDurationMs) {
        this.stats.peakRebuildDurationMs = durationMs;
      }

      this.reporter.report({
        type: 'folder.rebuildAll',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        durationMs,
        executionTimeMs: durationMs,
        affectedCount: changed.length,
        affectedUris: changedUris,
        workspaceFolders: 0,
        indexSizeBefore,
        indexSizeAfter: this.folderManager.childIndexSize,
      } as any);

      this.lastRebuildChangedUris = changedUris;

      return changed;
      } finally {
        this.activeRebuilds--;
      }
    };
  }

  private wrapRecomputeFolderStatus(): void {
    this.folderManager.recomputeFolderStatus = (folderUri: Uri): ProblemState => {
      if (this.disposed) return this.originalRecomputeFolderStatus(folderUri);
      const start = Date.now();
      const uriStr = folderUri.toString();
      const aggregateBefore = this.problemStore.get(folderUri);
      const result = this.originalRecomputeFolderStatus(folderUri);
      const now = Date.now();
      const durationMs = now - start;

      this.stats.totalRecomputes++;
      this.stats.recomputeDurationSumMs += durationMs;

      this.reporter.report({
        type: 'folder.recompute',
        timestamp: now,
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

  private emitAggregateEvent(uriStr: string, action: 'created' | 'updated' | 'removed' | 'unchanged', before?: ProblemState, after?: ProblemState, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    const errorDelta = (after?.errorCount ?? 0) - (before?.errorCount ?? 0);
    const warningDelta = (after?.warningCount ?? 0) - (before?.warningCount ?? 0);
    const infoDelta = (after?.infoCount ?? 0) - (before?.infoCount ?? 0);

    switch (action) {
      case 'created': this.stats.totalAggregatesCreated++; this.stats.totalFoldersProcessed++; this.aggregateCount++; break;
      case 'updated': this.stats.totalAggregatesUpdated++; break;
      case 'removed': this.stats.totalAggregatesRemoved++; this.aggregateCount = Math.max(0, this.aggregateCount - 1); break;
      case 'unchanged': this.stats.totalAggregatesUnchanged++; break;
    }

    this.reporter.report({
      type: 'folder.aggregate',
      timestamp: ts,
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
      parentUri: getParentKey(uriStr),
    } as any);

    if (after) {
      this.checkNegativeCounts(after, uriStr);
      this.checkInvalidSeverity(after, uriStr);
    }
    if (before && after && action === 'updated') {
      this.checkImpossibleTransition(before, after, uriStr);
    }
  }

  private wrapSetFolderAggregate(): void {
    this.problemStore.setFolderAggregate = (uri: Uri, state: ProblemState): boolean => {
      if (this.disposed) return this.originalSetFolderAggregate(uri, state);
      if (this.reentrant > 0) return this.originalSetFolderAggregate(uri, state);
      this.reentrant++;
      try {
        const start = Date.now();
        const uriStr = uri.toString();
        const before = this.problemStore.get(uri);
        const owner = this.problemStore.getOwningProvider(uri);
        const accepted = this.originalSetFolderAggregate(uri, state);
        const now = Date.now();
        const after = this.problemStore.get(uri);
        const durationMs = now - start;

        if (accepted) {
          if (!before) {
            this.emitAggregateEvent(uriStr, 'created', before, after, now);
          } else {
            this.emitAggregateEvent(uriStr, 'updated', before, after, now);
          }
          this.stats.totalStoreWrites++;
          this.stats.totalStoreWritesAccepted++;
        } else {
          this.emitAggregateEvent(uriStr, 'unchanged', before, after, now);
          this.stats.totalStoreWrites++;
          this.stats.totalStoreWritesRejected++;
        }

        this.reporter.report({
          type: 'folder.storeWrite',
          timestamp: now,
          traceId: generateTraceId(),
          source: 'FolderMonitor',
          uri: uriStr,
          accepted,
          rejectReason: accepted ? undefined : 'unchanged state',
          aggregateBefore: before,
          aggregateAfter: after,
          isNew: !before && accepted,
          owner,
          durationMs,
        } as any);

        return accepted;
      } finally {
        this.reentrant--;
      }
    };
  }

  private wrapStoreDelete(): void {
    this.problemStore.delete = (uri: Uri): boolean => {
      if (this.disposed) return this.originalStoreDelete(uri);
      if (!this.problemStore.isFolderAggregate(uri)) {
        return this.originalStoreDelete(uri);
      }
      if (this.reentrant > 0) return this.originalStoreDelete(uri);
      this.reentrant++;
      try {
        const start = Date.now();
        const uriStr = uri.toString();
        const before = this.problemStore.get(uri);
        const owner = this.problemStore.getOwningProvider(uri);
        const result = this.originalStoreDelete(uri);
        const now = Date.now();
        const durationMs = now - start;

        if (result && before) {
          this.emitAggregateEvent(uriStr, 'removed', before, undefined, now);

          this.reporter.report({
            type: 'folder.storeWrite',
            timestamp: now,
            traceId: generateTraceId(),
            source: 'FolderMonitor',
            uri: uriStr,
            accepted: true,
            aggregateBefore: before,
            aggregateAfter: undefined,
            isNew: false,
            owner,
            durationMs,
          } as any);
        }
        return result;
      } finally {
        this.reentrant--;
      }
    };
  }

  /* Check if a folder aggregate is stale (doesn't match its children) */
  private checkStaleAggregate(folderUri: Uri): void {
    const uriStr = folderUri.toString();
    if (!this.problemStore.isFolderAggregate(folderUri)) return;
    const current = this.problemStore.get(folderUri);
    if (!current) return;
    const recomputed = this.folderManager.recomputeFolderStatus(folderUri);
    if (
      current.errorCount !== recomputed.errorCount ||
      current.warningCount !== recomputed.warningCount ||
      current.infoCount !== recomputed.infoCount ||
      current.fileCount !== recomputed.fileCount
    ) {
      this.emitAssertion('STALE_AGGREGATE', `Folder aggregate for ${uriStr} does not match recomputed children`, uriStr,
        `current={errors:${current.errorCount},warnings:${current.warningCount},infos:${current.infoCount},files:${current.fileCount}} recomputed={errors:${recomputed.errorCount},warnings:${recomputed.warningCount},infos:${recomputed.infoCount},files:${recomputed.fileCount}}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Runtime assertions (Task 6)                                         */
  /* ------------------------------------------------------------------ */

  private emitAssertion(code: string, message: string, uri?: string, detail?: string): void {
    this.stats.totalAssertions++;
    this.reporter.report({
      type: 'folder.assertion',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'FolderMonitor',
      code,
      message,
      uri,
      detail,
    } as any);
  }

  /** Check for negative counts in a ProblemState */
  private checkNegativeCounts(state: ProblemState, uriStr: string): void {
    if (state.errorCount < 0) {
      this.emitAssertion('NEGATIVE_COUNT', `Negative errorCount for ${uriStr}`, uriStr, `errorCount=${state.errorCount}`);
    }
    if (state.warningCount < 0) {
      this.emitAssertion('NEGATIVE_COUNT', `Negative warningCount for ${uriStr}`, uriStr, `warningCount=${state.warningCount}`);
    }
    if (state.infoCount < 0) {
      this.emitAssertion('NEGATIVE_COUNT', `Negative infoCount for ${uriStr}`, uriStr, `infoCount=${state.infoCount}`);
    }
    if (state.fileCount < 0) {
      this.emitAssertion('NEGATIVE_COUNT', `Negative fileCount for ${uriStr}`, uriStr, `fileCount=${state.fileCount}`);
    }
  }

  /** Check that severity is within valid bounds */
  private checkInvalidSeverity(state: ProblemState, uriStr: string): void {
    if (state.severity < 0 || state.severity > 3) {
      this.emitAssertion('INVALID_SEVERITY', `Invalid severity ${state.severity} for ${uriStr}`, uriStr, `severity=${state.severity}`);
    }
  }

  /** Check if a folder aggregate is orphaned (no children in store) */
  private checkOrphanFolder(folderUri: Uri): void {
    const uriStr = folderUri.toString();
    if (!this.problemStore.isFolderAggregate(folderUri)) return;
    const current = this.problemStore.get(folderUri);
    if (!current) return;
    if (current.fileCount === 0) {
      this.emitAssertion('ORPHAN_FOLDER', `Orphan folder aggregate for ${uriStr} (fileCount=0)`, uriStr,
        `state={errors:${current.errorCount},warnings:${current.warningCount},infos:${current.infoCount}}`);
    }
  }

  /** Check if any ancestors were missed in propagation */
  private checkMissingAncestorUpdate(changedUris: string[], ancestors: string[], fileUri: string): void {
    const updatedSet = new Set(changedUris);
    for (const ancestor of ancestors) {
      if (!updatedSet.has(ancestor) && this.problemStore.isFolderAggregate(Uri.parse(ancestor))) {
        this.emitAssertion('MISSING_ANCESTOR_UPDATE',
          `Ancestor ${ancestor} should have been updated during propagation from ${fileUri}`,
          ancestor, `ancestorChain=[${ancestors.join(',')}] changed=[${changedUris.join(',')}]`);
      }
    }
  }

  /** Check for duplicate folder updates within a single propagation */
  private checkDuplicateFolderUpdate(changedUris: string[], fileUri: string): void {
    const seen = new Set<string>();
    for (const uri of changedUris) {
      if (seen.has(uri)) {
        this.emitAssertion('DUPLICATE_FOLDER_UPDATE', `Duplicate folder update for ${uri}`, uri,
          `propagation from ${fileUri}`);
      }
      seen.add(uri);
    }
  }

  /** Check for impossible aggregate transitions */
  private checkImpossibleTransition(before: ProblemState | undefined, after: ProblemState | undefined, uriStr: string): void {
    if (!before || !after) return;
    if (after.fileCount < before.fileCount && after.severity > before.severity) {
      this.emitAssertion('IMPOSSIBLE_TRANSITION',
        `Aggregate for ${uriStr} severity increased (${before.severity}→${after.severity}) while fileCount decreased (${before.fileCount}→${after.fileCount})`,
        uriStr, `before={severity:${before.severity},errors:${before.errorCount},files:${before.fileCount}} after={severity:${after.severity},errors:${after.errorCount},files:${after.fileCount}}`);
    }
  }

  /** Verify tracked aggregate count matches actual store state */
  private checkAggregateDrift(): void {
    let actualCount = 0;
    this.problemStore.forEachEntry((_key: string, _state: ProblemState, isFolder: boolean) => {
      if (isFolder) actualCount++;
    });
    if (actualCount !== this.aggregateCount) {
      this.emitAssertion('AGGREGATE_DRIFT',
        `Tracked aggregate count (${this.aggregateCount}) differs from actual store count (${actualCount})`,
        undefined, `drift=${actualCount - this.aggregateCount}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Snapshot                                                            */
  /* ------------------------------------------------------------------ */

  /** Capture a point-in-time snapshot of the monitor's state */
  captureSnapshot(): FolderSnapshot {
    this.checkAggregateDrift();
    return {
      activeUpdates: this.activeUpdates,
      activeRebuilds: this.activeRebuilds,
      indexSize: this.folderManager.childIndexSize,
      aggregateCount: this.aggregateCount,
      statistics: this.getStatistics(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Statistics                                                          */
  /* ------------------------------------------------------------------ */

  /** Get cumulative statistics with derived averages computed */
  getStatistics(): FolderStatistics {
    const s = { ...this.stats };
    s.averageRebuildDurationMs = s.totalRebuilds > 0 ? Math.round(s.rebuildDurationSumMs / s.totalRebuilds) : 0;
    s.averageUpdateAncestorsDurationMs = s.totalUpdateAncestors > 0 ? Math.round(s.updateAncestorsDurationSumMs / s.totalUpdateAncestors) : 0;
    s.averagePropagationDepth = s.totalUpdateAncestors > 0 ? Math.round(s.propagationDepthSum / s.totalUpdateAncestors) : 0;
    return s;
  }

  /* ------------------------------------------------------------------ */
  /*  Dispose                                                             */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    /* Restore in reverse wrapping order (LIFO) */
    this.problemStore.delete = this.originalStoreDelete;
    this.problemStore.setFolderAggregate = this.originalSetFolderAggregate;
    this.folderManager.recomputeFolderStatus = this.originalRecomputeFolderStatus;
    this.folderManager.rebuildAll = this.originalRebuildAll;
    this.folderManager.updateAncestors = this.originalUpdateAncestors;
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
