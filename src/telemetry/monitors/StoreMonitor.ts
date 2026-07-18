import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemState, ProblemSeverity } from '../../core/types';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { generateTraceId } from '../../telemetry/TelemetryConfig';
import { normalizeUriKey } from '../../core/uriKey';

/* ------------------------------------------------------------------ */
/*  Event data interfaces                                              */
/* ------------------------------------------------------------------ */

export interface StoreSetEvent {
  readonly type: 'store.set';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly provider?: string;
  readonly ownerBefore?: string;
  readonly ownerAfter?: string;
  readonly stateBefore?: ProblemState;
  readonly stateAfter?: ProblemState;
  readonly severityBefore?: ProblemSeverity;
  readonly severityAfter?: ProblemSeverity;
  readonly errorCountBefore: number;
  readonly warningCountBefore: number;
  readonly infoCountBefore: number;
  readonly errorCountAfter: number;
  readonly warningCountAfter: number;
  readonly infoCountAfter: number;
  readonly hasChanged: boolean;
  readonly accepted: boolean;
  readonly executionTimeMs: number;
}

export interface StoreSetRejectedEvent {
  readonly type: 'store.setRejected';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly provider: string;
  readonly requestedState: ProblemState;
  readonly currentOwner?: string;
  readonly currentOwnerPriority: number;
  readonly requesterPriority: number;
  readonly reason: 'ownership' | 'unchanged' | 'invalidData' | 'unknown';
  readonly detail: string;
  readonly executionTimeMs: number;
}

export interface StoreDeleteEvent {
  readonly type: 'store.delete';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly stateBefore?: ProblemState;
  readonly ownerBefore?: string;
  readonly accepted: boolean;
  readonly executionTimeMs: number;
}

export interface StoreClearEvent {
  readonly type: 'store.clear';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly entryCountBefore: number;
  readonly executionTimeMs: number;
}

export interface StoreBeginBatchEvent {
  readonly type: 'store.beginBatch';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
}

export interface StoreEndBatchEvent {
  readonly type: 'store.endBatch';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly writes: number;
  readonly rejectedWrites: number;
  readonly ownershipConflicts: number;
  readonly durationMs: number;
}

export interface StoreConfigureProviderEvent {
  readonly type: 'store.configureProvider';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly providerName: string;
  readonly priority: number;
  readonly executionTimeMs: number;
}

export interface StoreReleaseOwnershipEvent {
  readonly type: 'store.releaseOwnership';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly providerName: string;
  readonly releasedKeys: number;
  readonly executionTimeMs: number;
}

export interface StoreSetFolderAggregateEvent {
  readonly type: 'store.setFolderAggregate';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly stateBefore?: ProblemState;
  readonly stateAfter?: ProblemState;
  readonly accepted: boolean;
  readonly executionTimeMs: number;
}

export interface OwnershipAcquiredEvent {
  readonly type: 'store.ownership.acquired';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly provider: string;
  readonly priority: number;
}

export interface OwnershipReleasedEvent {
  readonly type: 'store.ownership.released';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly provider: string;
}

export interface OwnershipTransferredEvent {
  readonly type: 'store.ownership.transferred';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly fromProvider: string;
  readonly toProvider: string;
  readonly fromPriority: number;
  readonly toPriority: number;
}

export interface OwnershipRejectedEvent {
  readonly type: 'store.ownership.rejected';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly uri: string;
  readonly requester: string;
  readonly currentOwner: string;
  readonly requesterPriority: number;
  readonly currentOwnerPriority: number;
}

export interface StoreAssertionFailureEvent {
  readonly type: 'store.assertion.failure';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly assertion: string;
  readonly detail: string;
  readonly uri?: string;
}

export interface StorePerformanceSnapshotEvent {
  readonly type: 'store.performance.snapshot';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly totalWrites: number;
  readonly totalRejected: number;
  readonly totalOwnershipConflicts: number;
  readonly averageSetDurationMs: number;
  readonly batchCount: number;
  readonly entryCount: number;
}

/* ------------------------------------------------------------------ */
/*  StoreMonitor                                                       */
/* ------------------------------------------------------------------ */

const ASSERTION_SAMPLE_RATE = 0.1;

export class StoreMonitor {
  /* wrapped originals */
  private originalSet!: (uri: Uri, state: ProblemState, providerName?: string) => boolean;
  private originalDelete!: (uri: Uri) => boolean;
  private originalClear!: () => void;
  private originalBeginBatch!: () => void;
  private originalEndBatch!: () => void;
  private originalConfigureProvider!: (providerName: string, priority: number) => void;
  private originalReleaseOwnership!: (providerName: string) => void;
  private originalSetFolderAggregate!: (uri: Uri, state: ProblemState) => boolean;

  /* performance counters */
  private totalWrites = 0;
  private totalRejected = 0;
  private totalOwnershipConflicts = 0;
  private setDurationSum = 0;
  private setDurationCount = 0;
  private batchCount = 0;
  private batchWriteCount = 0;
  private batchRejectedCount = 0;
  private batchConflictCount = 0;
  private batchStartTime = 0;

  /* ownership tracking */
  private ownerCounts = new Map<string, number>();
  private ownedUris = new Map<string, string>();

  private disposed = false;

  constructor(
    private readonly store: ProblemStore,
    private readonly reporter: TelemetryReporter,
  ) {
    this.bindOriginals();
    this.wrapMethods();
  }

  /* ------------------------------------------------------------------ */
  /*  Method wrapping                                                    */
  /* ------------------------------------------------------------------ */

  private bindOriginals(): void {
    this.originalSet = this.store.set.bind(this.store);
    this.originalDelete = this.store.delete.bind(this.store);
    this.originalClear = this.store.clear.bind(this.store);
    this.originalBeginBatch = this.store.beginBatch.bind(this.store);
    this.originalEndBatch = this.store.endBatch.bind(this.store);
    this.originalConfigureProvider = this.store.configureProvider.bind(this.store);
    this.originalReleaseOwnership = this.store.releaseOwnership.bind(this.store);
    this.originalSetFolderAggregate = this.store.setFolderAggregate.bind(this.store);
  }

  private wrapMethods(): void {
    const self = this;

    /* — set() — */
    this.store.set = function (uri: Uri, state: ProblemState, providerName?: string): boolean {
      if (self.disposed) return self.originalSet(uri, state, providerName);

      if (!uri) {
        self.reportAssertion('nullUri', 'set() called with null/undefined URI');
        return self.originalSet(uri, state, providerName);
      }

      const start = Date.now();
      const traceId = generateTraceId();
      const uriStr = uri.toString();
      const normKey = normalizeUriKey(uri);
      const ownerBefore = self.store.getOwningProvider(uri);
      const stateBefore = self.store.get(uri);
      const severityBefore = stateBefore?.severity;
      const errorCountBefore = stateBefore?.errorCount ?? 0;
      const warningCountBefore = stateBefore?.warningCount ?? 0;
      const infoCountBefore = stateBefore?.infoCount ?? 0;

      const accepted = self.originalSet(uri, state, providerName);
      const executionTimeMs = Date.now() - start;

      if (accepted) {
        const ownerAfter = self.store.getOwningProvider(uri);
        const stateAfter = self.store.get(uri);
        const severityAfter = stateAfter?.severity;
        const errorCountAfter = stateAfter?.errorCount ?? 0;
        const warningCountAfter = stateAfter?.warningCount ?? 0;
        const infoCountAfter = stateAfter?.infoCount ?? 0;

        const hasChanged = self.hasStateChanged(stateBefore, state);

        self.totalWrites++;
        self.setDurationSum += executionTimeMs;
        self.setDurationCount++;
        if (self.batchStartTime > 0) self.batchWriteCount++;

        self.reporter.report({
          type: 'store.set',
          timestamp: start,
          traceId,
          source: 'StoreMonitor',
          uri: uriStr,
          provider: providerName,
          ownerBefore,
          ownerAfter,
          stateBefore,
          stateAfter,
          severityBefore,
          severityAfter,
          errorCountBefore,
          warningCountBefore,
          infoCountBefore,
          errorCountAfter,
          warningCountAfter,
          infoCountAfter,
          hasChanged,
          accepted: true,
          executionTimeMs,
        } as any);

        /* Ownership tracking */
        if (providerName) {
          if (!ownerBefore) {
            self.ownerCounts.set(providerName, (self.ownerCounts.get(providerName) ?? 0) + 1);
            self.ownedUris.set(normKey, providerName);
            self.reporter.report({
              type: 'store.ownership.acquired',
              timestamp: start,
              traceId,
              source: 'StoreMonitor',
              uri: uriStr,
              provider: providerName,
              priority: self.store.getProviderPriority(providerName),
            } as any);
          } else if (ownerBefore !== providerName) {
            self.totalOwnershipConflicts++;
            if (self.batchStartTime > 0) self.batchConflictCount++;
            self.decrementOwnerCount(ownerBefore);
            self.ownerCounts.set(providerName, (self.ownerCounts.get(providerName) ?? 0) + 1);
            self.ownedUris.set(normKey, providerName);
            self.reporter.report({
              type: 'store.ownership.transferred',
              timestamp: start,
              traceId,
              source: 'StoreMonitor',
              uri: uriStr,
              fromProvider: ownerBefore,
              toProvider: providerName,
              fromPriority: self.store.getProviderPriority(ownerBefore),
              toPriority: self.store.getProviderPriority(providerName),
            } as any);
          }
        }
      } else {
        self.totalRejected++;
        if (self.batchStartTime > 0) self.batchRejectedCount++;

        /* Determine rejection reason */
        const reason = self.determineRejectReason(providerName, ownerBefore, state, stateBefore);
        self.reporter.report({
          type: 'store.setRejected',
          timestamp: start,
          traceId,
          source: 'StoreMonitor',
          uri: uriStr,
          provider: providerName ?? 'unknown',
          requestedState: state,
          currentOwner: ownerBefore,
          currentOwnerPriority: ownerBefore ? self.store.getProviderPriority(ownerBefore) : -1,
          requesterPriority: providerName ? self.store.getProviderPriority(providerName) : -1,
          reason: reason.reason,
          detail: reason.detail,
          executionTimeMs,
        } as any);

        /* Ownership rejection event */
        if (reason.reason === 'ownership' && ownerBefore && providerName) {
          self.reporter.report({
            type: 'store.ownership.rejected',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            uri: uriStr,
            requester: providerName,
            currentOwner: ownerBefore,
            requesterPriority: self.store.getProviderPriority(providerName),
            currentOwnerPriority: self.store.getProviderPriority(ownerBefore),
          } as any);
        }
      }

      self.sampleAssertions();
      return accepted;
    };

    /* — delete() — */
    this.store.delete = function (uri: Uri): boolean {
      if (self.disposed) return self.originalDelete(uri);

      if (!uri) {
        self.reportAssertion('nullUri', 'delete() called with null/undefined URI');
        return self.originalDelete(uri);
      }

      const start = Date.now();
      const traceId = generateTraceId();
      const uriStr = uri.toString();
      const normKey = normalizeUriKey(uri);
      const stateBefore = self.store.get(uri);
      const ownerBefore = self.store.getOwningProvider(uri);

      const accepted = self.originalDelete(uri);
      const executionTimeMs = Date.now() - start;

      self.reporter.report({
        type: 'store.delete',
        timestamp: start,
        traceId,
        source: 'StoreMonitor',
        uri: uriStr,
        stateBefore,
        ownerBefore,
        accepted,
        executionTimeMs,
      } as any);

      if (accepted && ownerBefore) {
        self.decrementOwnerCount(ownerBefore);
        self.ownedUris.delete(normKey);
        self.reporter.report({
          type: 'store.ownership.released',
          timestamp: start,
          traceId,
          source: 'StoreMonitor',
          uri: uriStr,
          provider: ownerBefore,
        } as any);
      }

      self.sampleAssertions();
      return accepted;
    };

    /* — clear() — */
    this.store.clear = function (): void {
      if (self.disposed) { self.originalClear(); return; }

      const start = Date.now();
      const traceId = generateTraceId();
      const entryCountBefore = self.store.size();

      self.originalClear();
      const executionTimeMs = Date.now() - start;

      self.reporter.report({
        type: 'store.clear',
        timestamp: start,
        traceId,
        source: 'StoreMonitor',
        entryCountBefore,
        executionTimeMs,
      } as any);

      self.sampleAssertions();
    };

    /* — beginBatch() — */
    this.store.beginBatch = function (): void {
      if (self.disposed) { self.originalBeginBatch(); return; }

      const traceId = generateTraceId();
      self.batchStartTime = Date.now();
      self.batchWriteCount = 0;
      self.batchRejectedCount = 0;
      self.batchConflictCount = 0;

      self.originalBeginBatch();

      self.reporter.report({
        type: 'store.beginBatch',
        timestamp: self.batchStartTime,
        traceId,
        source: 'StoreMonitor',
      } as any);
    };

    /* — endBatch() — */
    this.store.endBatch = function (): void {
      if (self.disposed) { self.originalEndBatch(); return; }

      const traceId = generateTraceId();
      const now = Date.now();
      const durationMs = self.batchStartTime > 0 ? now - self.batchStartTime : 0;
      const writes = self.batchWriteCount;
      const rejectedWrites = self.batchRejectedCount;
      const ownershipConflicts = self.batchConflictCount;

      self.originalEndBatch();

      self.batchCount++;
      self.batchStartTime = 0;

      self.reporter.report({
        type: 'store.endBatch',
        timestamp: now,
        traceId,
        source: 'StoreMonitor',
        writes,
        rejectedWrites,
        ownershipConflicts,
        durationMs,
      } as any);

      self.sampleAssertions();
    };

    /* — configureProvider() — */
    this.store.configureProvider = function (providerName: string, priority: number): void {
      if (self.disposed) { self.originalConfigureProvider(providerName, priority); return; }

      const start = Date.now();
      const traceId = generateTraceId();

      self.originalConfigureProvider(providerName, priority);
      const executionTimeMs = Date.now() - start;

      self.reporter.report({
        type: 'store.configureProvider',
        timestamp: start,
        traceId,
        source: 'StoreMonitor',
        providerName,
        priority,
        executionTimeMs,
      } as any);
    };

    /* — releaseOwnership() — */
    this.store.releaseOwnership = function (providerName: string): void {
      if (self.disposed) { self.originalReleaseOwnership(providerName); return; }

      const start = Date.now();
      const traceId = generateTraceId();
      const releasedCount = self.ownerCounts.get(providerName) ?? 0;

      self.originalReleaseOwnership(providerName);
      const executionTimeMs = Date.now() - start;

      /* Reset ownership tracking for this provider */
      self.ownerCounts.set(providerName, 0);
      for (const [u, p] of self.ownedUris) {
        if (p === providerName) self.ownedUris.delete(u);
      }

      self.reporter.report({
        type: 'store.releaseOwnership',
        timestamp: start,
        traceId,
        source: 'StoreMonitor',
        providerName,
        releasedKeys: releasedCount,
        executionTimeMs,
      } as any);
    };

    /* — setFolderAggregate() — */
    this.store.setFolderAggregate = function (uri: Uri, state: ProblemState): boolean {
      if (self.disposed) return self.originalSetFolderAggregate(uri, state);

      if (!uri) {
        self.reportAssertion('nullUri', 'setFolderAggregate() called with null/undefined URI');
        return self.originalSetFolderAggregate(uri, state);
      }

      const start = Date.now();
      const traceId = generateTraceId();
      const uriStr = uri.toString();
      const stateBefore = self.store.get(uri);

      const accepted = self.originalSetFolderAggregate(uri, state);
      const executionTimeMs = Date.now() - start;

      const stateAfter = self.store.get(uri);

      self.reporter.report({
        type: 'store.setFolderAggregate',
        timestamp: start,
        traceId,
        source: 'StoreMonitor',
        uri: uriStr,
        stateBefore,
        stateAfter,
        accepted,
        executionTimeMs,
      } as any);

      self.sampleAssertions();
      return accepted;
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private hasStateChanged(before: ProblemState | undefined, after: ProblemState): boolean {
    if (!before) return true;
    return before.errorCount !== after.errorCount
      || before.warningCount !== after.warningCount
      || before.infoCount !== after.infoCount
      || before.severity !== after.severity
      || before.fileCount !== after.fileCount;
  }

  private decrementOwnerCount(providerName: string): void {
    const current = this.ownerCounts.get(providerName) ?? 0;
    if (current <= 1) {
      this.ownerCounts.delete(providerName);
    } else {
      this.ownerCounts.set(providerName, current - 1);
    }
  }

  private determineRejectReason(
    providerName: string | undefined,
    ownerBefore: string | undefined,
    requestedState: ProblemState,
    stateBefore: ProblemState | undefined,
  ): { reason: 'ownership' | 'unchanged' | 'invalidData' | 'unknown'; detail: string } {
    /* Check for invalid data */
    if (requestedState.errorCount < 0 || requestedState.warningCount < 0 || requestedState.infoCount < 0) {
      return { reason: 'invalidData', detail: `Negative counts: ${requestedState.errorCount}e/${requestedState.warningCount}w/${requestedState.infoCount}i` };
    }
    if (requestedState.fileCount < 0) {
      return { reason: 'invalidData', detail: `Negative fileCount: ${requestedState.fileCount}` };
    }
    if (requestedState.severity < ProblemSeverity.None || requestedState.severity > ProblemSeverity.Error) {
      return { reason: 'invalidData', detail: `Invalid severity: ${requestedState.severity}` };
    }

    /* Check for ownership rejection */
    if (providerName && ownerBefore && ownerBefore !== providerName) {
      const ownerPriority = this.store.getProviderPriority(ownerBefore);
      const requesterPriority = this.store.getProviderPriority(providerName);
      if (requesterPriority < ownerPriority) {
        return {
          reason: 'ownership',
          detail: `Provider "${providerName}" (priority ${requesterPriority}) lower than current owner "${ownerBefore}" (priority ${ownerPriority})`,
        };
      }
      if (requesterPriority === ownerPriority) {
        return {
          reason: 'ownership',
          detail: `Provider "${providerName}" has equal priority (${requesterPriority}) to current owner "${ownerBefore}" — store uses first-writer-wins`,
        };
      }
    }

    /* Check for unchanged state */
    if (stateBefore && !this.hasStateChanged(stateBefore, requestedState)) {
      return { reason: 'unchanged', detail: `State identical to current — no update needed` };
    }

    /* Fallback */
    if (providerName && !ownerBefore) {
      return { reason: 'unknown', detail: `Write rejected for unknown reason` };
    }
    return { reason: 'unknown', detail: `Write rejected for unknown reason` };
  }

  /* ------------------------------------------------------------------ */
  /*  Runtime assertions (passive, sampled)                              */
  /* ------------------------------------------------------------------ */

  private sampleAssertions(): void {
    if (Math.random() >= ASSERTION_SAMPLE_RATE) return;
    this.runAssertions();
  }

  private runAssertions(): void {
    try {
      let entryCount = 0;
      let folderCount = 0;
      let negativeCounts = 0;
      let badSeverity = 0;
      const fileKeys: string[] = [];

      this.store.forEachEntry((key, state, isFolder) => {
        entryCount++;
        if (isFolder) folderCount++;
        else fileKeys.push(key);
        if (state.errorCount < 0 || state.warningCount < 0 || state.infoCount < 0) {
          negativeCounts++;
        }
        if (state.severity < ProblemSeverity.None || state.severity > ProblemSeverity.Error) {
          badSeverity++;
        }
      });

      /* Check running totals */
      const totals = this.store.computeTotals();
      if (totals.errorCount < 0 || totals.warningCount < 0 || totals.infoCount < 0) {
        this.reportAssertion('totals', `Negative running totals: ${totals.errorCount}e/${totals.warningCount}w/${totals.infoCount}i`);
      }

      if (negativeCounts > 0) {
        this.reportAssertion('negativeCounts', `${negativeCounts} entries have negative counts`);
      }

      if (badSeverity > 0) {
        this.reportAssertion('invalidSeverity', `${badSeverity} entries have invalid severity`);
      }

      /* Check store size sanity */
      if (entryCount !== this.store.size()) {
        this.reportAssertion('sizeMismatch', `forEachEntry yielded ${entryCount} entries but size() returns ${this.store.size()}`);
      }

      /* Check owner missing: every file entry should have a tracked owner */
      if (this.ownedUris.size > 0) {
        let missingOwner = 0;
        for (const key of fileKeys) {
          if (!this.ownedUris.has(key)) {
            missingOwner++;
          }
        }
        if (missingOwner > 0) {
          this.reportAssertion('ownerMissing', `${missingOwner} file entries have no tracked owner`);
        }

        /* Check owner exists for ownedUris entries not in store (stale tracking) */
        let staleEntries = 0;
        const allKeys = new Set(fileKeys);
        for (const key of this.ownedUris.keys()) {
          if (!allKeys.has(key)) {
            staleEntries++;
          }
        }
        if (staleEntries > 0) {
          this.reportAssertion('staleOwnership', `${staleEntries} ownedUris entries are not in the store`);
        }
      }

      /* Check folder aggregates without children */
      {
        let orphanFolders = 0;
        this.store.forEachEntry((key, _state, isFolder) => {
          if (!isFolder) return;
          const hasChild = fileKeys.some(fk => fk.startsWith(key + '/'));
          if (!hasChild) orphanFolders++;
        });
        if (orphanFolders > 0) {
          this.reportAssertion('emptyFolderAggregate', `${orphanFolders} folder aggregates have no file children`);
        }
      }
    } catch (err) {
      this.reportAssertion('exception', `Assertion threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private reportAssertion(assertion: string, detail: string, uri?: string): void {
    this.reporter.report({
      type: 'store.assertion.failure',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'StoreMonitor',
      assertion,
      detail,
      uri,
    } as any);
  }

  /* ------------------------------------------------------------------ */
  /*  Performance snapshot                                               */
  /* ------------------------------------------------------------------ */

  capturePerformanceSnapshot(): void {
    const traceId = generateTraceId();
    const avg = this.setDurationCount > 0 ? this.setDurationSum / this.setDurationCount : 0;

    this.reporter.report({
      type: 'store.performance.snapshot',
      timestamp: Date.now(),
      traceId,
      source: 'StoreMonitor',
      totalWrites: this.totalWrites,
      totalRejected: this.totalRejected,
      totalOwnershipConflicts: this.totalOwnershipConflicts,
      averageSetDurationMs: Math.round(avg * 100) / 100,
      batchCount: this.batchCount,
      entryCount: this.store.size(),
    } as any);
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.store.set = this.originalSet;
    this.store.delete = this.originalDelete;
    this.store.clear = this.originalClear;
    this.store.beginBatch = this.originalBeginBatch;
    this.store.endBatch = this.originalEndBatch;
    this.store.configureProvider = this.originalConfigureProvider;
    this.store.releaseOwnership = this.originalReleaseOwnership;
    this.store.setFolderAggregate = this.originalSetFolderAggregate;
  }
}

/** Create a StoreMonitor for the given ProblemStore */
export function createStoreMonitor(
  store: ProblemStore,
  reporter: TelemetryReporter,
): StoreMonitor {
  return new StoreMonitor(store, reporter);
}