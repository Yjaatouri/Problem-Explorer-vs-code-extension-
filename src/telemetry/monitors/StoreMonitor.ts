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
  readonly reason: 'ownership' | 'unchanged' | 'unknown';
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
  readonly nestedEventsSkipped: number;
}

export interface StoreDeleteByPrefixEvent {
  readonly type: 'store.deleteByPrefix';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly prefix: string;
  readonly deletedCount: number;
  readonly executionTimeMs: number;
}

export interface StoreMovePrefixEvent {
  readonly type: 'store.movePrefix';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly oldPrefix: string;
  readonly newPrefix: string;
  readonly movedCount: number;
  readonly executionTimeMs: number;
}

export interface StoreOwnershipMovedEvent {
  readonly type: 'store.ownership.moved';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly oldUri: string;
  readonly newUri: string;
  readonly provider: string;
}

export interface StoreUnconfigureProviderEvent {
  readonly type: 'store.unconfigureProvider';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly providerName: string;
  readonly executionTimeMs: number;
}

export interface StoreDisposeEvent {
  readonly type: 'store.dispose';
  readonly timestamp: number;
  readonly traceId: string;
  readonly source: 'StoreMonitor';
  readonly entryCount: number;
  readonly totalWrites: number;
  readonly totalRejected: number;
  readonly totalOwnershipConflicts: number;
  readonly batchCount: number;
}

/* ------------------------------------------------------------------ */
/*  StoreMonitor                                                       */
/* ------------------------------------------------------------------ */

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
  private originalDeleteByPrefix!: (prefix: string) => number;
  private originalMovePrefix!: (oldPrefix: string, newPrefix: string) => number;
  private originalUnconfigureProvider!: (providerName: string) => void;
  private originalDispose!: () => void;

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
  private batchDepth = 0;

  /* nested batch state stack — each entry: { startTime, writeCount, rejectedCount, conflictCount } */
  private batchStateStack: Array<{ startTime: number; writeCount: number; rejectedCount: number; conflictCount: number }> = [];

  /* ownership tracking */
  private ownerCounts = new Map<string, number>();
  private ownedUris = new Map<string, string>();

  /* reentrancy guard — prevents recursive telemetry if an event subscriber calls back into the store */
  private reentrant = 0;
  private nestedEventsSkipped = 0;
  private nestedSetsSkipped = 0;
  private nestedDeletesSkipped = 0;
  private nestedClearsSkipped = 0;
  private nestedBeginBatchesSkipped = 0;
  private nestedEndBatchesSkipped = 0;

  /* assertion throttling: sample at most once per 500ms */
  private lastAssertionTime = 0;

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
    /* Guard: verify store methods haven't been wrapped by another component */
    const proto = Object.getPrototypeOf(this.store);
    const methodNames = ['set', 'delete', 'clear', 'beginBatch', 'endBatch',
      'configureProvider', 'releaseOwnership', 'setFolderAggregate',
      'deleteByPrefix', 'movePrefix', 'unconfigureProvider', 'dispose'] as const;
    for (const name of methodNames) {
      if ((this.store as any)[name] !== (proto as any)[name]) {
        console.warn(`[StoreMonitor] "${name}" was already replaced — wrapping may be fragile`);
      }
    }

    this.originalSet = this.store.set.bind(this.store);
    this.originalDelete = this.store.delete.bind(this.store);
    this.originalClear = this.store.clear.bind(this.store);
    this.originalBeginBatch = this.store.beginBatch.bind(this.store);
    this.originalEndBatch = this.store.endBatch.bind(this.store);
    this.originalConfigureProvider = this.store.configureProvider.bind(this.store);
    this.originalReleaseOwnership = this.store.releaseOwnership.bind(this.store);
    this.originalSetFolderAggregate = this.store.setFolderAggregate.bind(this.store);
    this.originalDeleteByPrefix = this.store.deleteByPrefix.bind(this.store);
    this.originalMovePrefix = this.store.movePrefix.bind(this.store);
    this.originalUnconfigureProvider = this.store.unconfigureProvider.bind(this.store);
    this.originalDispose = this.store.dispose.bind(this.store);
  }

  private wrapMethods(): void {
    

    /* — set() — */
    this.store.set = (uri: Uri, state: ProblemState, providerName?: string): boolean => {
      if (this.disposed) return this.originalSet(uri, state, providerName);
      if (this.reentrant > 0) {
        this.nestedEventsSkipped++;
        this.nestedSetsSkipped++;
        const result = this.originalSet(uri, state, providerName);
        if (result) { this.totalWrites++; if (this.batchStartTime > 0) this.batchWriteCount++; }
        else { this.totalRejected++; if (this.batchStartTime > 0) this.batchRejectedCount++; }
        return result;
      }

      if (!uri) {
        this.safeReportAssertion('nullUri', 'set() called with null/undefined URI');
        return this.originalSet(uri, state, providerName);
      }
      if (state == null) {
        this.safeReportAssertion('nullState', 'set() called with null/undefined state');
        return this.originalSet(uri, state, providerName);
      }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const uriStr = uri.toString();
        const normKey = normalizeUriKey(uri);
        const ownerBefore = this.store.getOwningProvider(uri);
        const stateBefore = this.store.get(uri);
        const severityBefore = stateBefore?.severity;
        const errorCountBefore = stateBefore?.errorCount ?? 0;
        const warningCountBefore = stateBefore?.warningCount ?? 0;
        const infoCountBefore = stateBefore?.infoCount ?? 0;

        const accepted = this.originalSet(uri, state, providerName);
        const executionTimeMs = Date.now() - start;

        try {
          if (accepted) {
            const ownerAfter = this.store.getOwningProvider(uri);
            const stateAfter = this.store.get(uri);
            const severityAfter = stateAfter?.severity;
            const errorCountAfter = stateAfter?.errorCount ?? 0;
            const warningCountAfter = stateAfter?.warningCount ?? 0;
            const infoCountAfter = stateAfter?.infoCount ?? 0;

            const hasChanged = this.hasStateChanged(stateBefore, state);

            this.totalWrites++;
            if (this.batchStartTime > 0) this.batchWriteCount++;

            this.safeReport({
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
            });

            /* Ownership tracking — trust store's post-call state (ownerAfter) */
            if (providerName !== undefined && ownerAfter === providerName) {
              if (!ownerBefore) {
                this.ownerCounts.set(providerName, (this.ownerCounts.get(providerName) ?? 0) + 1);
                this.ownedUris.set(normKey, providerName);
                this.safeReport({
                  type: 'store.ownership.acquired',
                  timestamp: start,
                  traceId,
                  source: 'StoreMonitor',
                  uri: uriStr,
                  provider: providerName,
                  priority: this.store.getProviderPriority(providerName),
                });
              } else if (ownerBefore !== providerName) {
                this.totalOwnershipConflicts++;
                if (this.batchStartTime > 0) this.batchConflictCount++;
                this.decrementOwnerCount(ownerBefore);
                this.ownerCounts.set(providerName, (this.ownerCounts.get(providerName) ?? 0) + 1);
                this.ownedUris.set(normKey, providerName);
                this.safeReport({
                  type: 'store.ownership.transferred',
                  timestamp: start,
                  traceId,
                  source: 'StoreMonitor',
                  uri: uriStr,
                  fromProvider: ownerBefore,
                  toProvider: providerName,
                  fromPriority: this.store.getProviderPriority(ownerBefore),
                  toPriority: this.store.getProviderPriority(providerName),
                });
              }
            }
          } else {
            this.totalRejected++;
            if (this.batchStartTime > 0) this.batchRejectedCount++;

            /* Determine rejection reason */
            let reason: { reason: 'ownership' | 'unchanged' | 'unknown'; detail: string };
            try {
              reason = this.determineRejectReason(providerName, ownerBefore, state, stateBefore);
            } catch (reasonErr) {
              reason = { reason: 'unknown', detail: `determineRejectReason threw: ${reasonErr instanceof Error ? reasonErr.message : String(reasonErr)}` };
            }
            this.safeReport({
              type: 'store.setRejected',
              timestamp: start,
              traceId,
              source: 'StoreMonitor',
              uri: uriStr,
              provider: providerName ?? 'unknown',
              requestedState: state,
              currentOwner: ownerBefore,
              currentOwnerPriority: ownerBefore ? this.store.getProviderPriority(ownerBefore) : -1,
              requesterPriority: providerName ? this.store.getProviderPriority(providerName) : -1,
              reason: reason.reason,
              detail: reason.detail,
              executionTimeMs,
            });

            /* Ownership rejection event */
            if (reason.reason === 'ownership' && ownerBefore && providerName) {
              this.safeReport({
                type: 'store.ownership.rejected',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                uri: uriStr,
                requester: providerName,
                currentOwner: ownerBefore,
                requesterPriority: this.store.getProviderPriority(providerName),
                currentOwnerPriority: this.store.getProviderPriority(ownerBefore),
              });
            }
          }
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `set wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        /* Track duration for all set calls (accepted + rejected) */
        this.setDurationSum += executionTimeMs;
        this.setDurationCount++;

        try {
          this.sampleAssertions();
        } catch {
          /* sampleAssertions already self-protects; swallow defensively */
        }
        return accepted;
      } finally {
        this.reentrant--;
      }
    };

    /* — delete() — */
    this.store.delete = (uri: Uri): boolean => {
      if (this.disposed) return this.originalDelete(uri);
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.nestedDeletesSkipped++; return this.originalDelete(uri); }

      if (!uri) {
        this.safeReportAssertion('nullUri', 'delete() called with null/undefined URI');
        return this.originalDelete(uri);
      }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const uriStr = uri.toString();
        const normKey = normalizeUriKey(uri);
        const stateBefore = this.store.get(uri);
        const ownerBefore = this.store.getOwningProvider(uri);

        const accepted = this.originalDelete(uri);
        const executionTimeMs = Date.now() - start;

        try {
          this.safeReport({
            type: 'store.delete',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            uri: uriStr,
            stateBefore,
            ownerBefore,
            accepted,
            executionTimeMs,
          });

          if (accepted && ownerBefore) {
            this.decrementOwnerCount(ownerBefore);
            this.ownedUris.delete(normKey);
            this.safeReport({
              type: 'store.ownership.released',
              timestamp: start,
              traceId,
              source: 'StoreMonitor',
              uri: uriStr,
              provider: ownerBefore,
            });
          }
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `delete wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          this.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
        return accepted;
      } finally {
        this.reentrant--;
      }
    };

    /* — clear() — */
    this.store.clear = (): void => {
      if (this.disposed) { this.originalClear(); return; }
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.nestedClearsSkipped++; this.originalClear(); return; }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const entryCountBefore = this.store.size();

        this.originalClear();
        const executionTimeMs = Date.now() - start;

        try {
          /* Reset non-batch monitor state to reflect empty store */
          this.totalWrites = 0;
          this.totalRejected = 0;
          this.totalOwnershipConflicts = 0;
          this.setDurationSum = 0;
          this.setDurationCount = 0;
          this.nestedEventsSkipped = 0;
          this.nestedSetsSkipped = 0;
          this.nestedDeletesSkipped = 0;
          this.nestedClearsSkipped = 0;
          this.nestedBeginBatchesSkipped = 0;
          this.nestedEndBatchesSkipped = 0;
          this.ownerCounts.clear();
          this.ownedUris.clear();

          /* If not inside a batch, also reset batch state */
          if (this.batchDepth === 0) {
            this.batchCount = 0;
            this.batchStartTime = 0;
            this.batchWriteCount = 0;
            this.batchRejectedCount = 0;
            this.batchConflictCount = 0;
            this.batchStateStack = [];
          }

          this.safeReport({
            type: 'store.clear',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            entryCountBefore,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `clear wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          this.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
      } finally {
        this.reentrant--;
      }
    };

    /* — beginBatch() — */
    this.store.beginBatch = (): void => {
      if (this.disposed) { this.originalBeginBatch(); return; }
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.nestedBeginBatchesSkipped++; this.originalBeginBatch(); return; }

      this.reentrant++;
      try {
        /* Save outer batch state if already in a batch */
        if (this.batchDepth > 0) {
          this.batchStateStack.push({
            startTime: this.batchStartTime,
            writeCount: this.batchWriteCount,
            rejectedCount: this.batchRejectedCount,
            conflictCount: this.batchConflictCount,
          });
        }
        this.batchDepth++;
        this.batchStartTime = Date.now();
        this.batchWriteCount = 0;
        this.batchRejectedCount = 0;
        this.batchConflictCount = 0;

        this.originalBeginBatch();

        try {
          const traceId = generateTraceId();
          this.safeReport({
            type: 'store.beginBatch',
            timestamp: this.batchStartTime,
            traceId,
            source: 'StoreMonitor',
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `beginBatch wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        this.reentrant--;
      }
    };

    /* — endBatch() — */
    this.store.endBatch = (): void => {
      if (this.disposed) { this.originalEndBatch(); return; }
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.nestedEndBatchesSkipped++; this.originalEndBatch(); return; }

      this.reentrant++;
      try {
        const traceId = generateTraceId();
        const now = Date.now();
        const durationMs = this.batchStartTime > 0 ? now - this.batchStartTime : 0;
        const writes = this.batchWriteCount;
        const rejectedWrites = this.batchRejectedCount;
        const ownershipConflicts = this.batchConflictCount;

        this.originalEndBatch();

        try {
          this.batchCount++;
          this.batchStartTime = 0;

          this.safeReport({
            type: 'store.endBatch',
            timestamp: now,
            traceId,
            source: 'StoreMonitor',
            writes,
            rejectedWrites,
            ownershipConflicts,
            durationMs,
          });

          /* Restore outer batch state if nested */
          this.batchDepth--;
          if (this.batchDepth > 0) {
            const prev = this.batchStateStack.pop();
            if (prev) {
              this.batchStartTime = prev.startTime;
              this.batchWriteCount = prev.writeCount;
              this.batchRejectedCount = prev.rejectedCount;
              this.batchConflictCount = prev.conflictCount;
            }
          }
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `endBatch wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          this.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
      } finally {
        this.reentrant--;
      }
    };

    /* — configureProvider() — */
    this.store.configureProvider = (providerName: string, priority: number): void => {
      if (this.disposed) { this.originalConfigureProvider(providerName, priority); return; }
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.originalConfigureProvider(providerName, priority); return; }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        this.originalConfigureProvider(providerName, priority);
        const executionTimeMs = Date.now() - start;

        try {
          this.safeReport({
            type: 'store.configureProvider',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            providerName,
            priority,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `configureProvider wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        this.reentrant--;
      }
    };

    /* — releaseOwnership() — */
    this.store.releaseOwnership = (providerName: string): void => {
      if (this.disposed) { this.originalReleaseOwnership(providerName); return; }
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.originalReleaseOwnership(providerName); return; }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        this.originalReleaseOwnership(providerName);
        const executionTimeMs = Date.now() - start;

        try {
          /* Reset ownership tracking for this provider */
          this.ownerCounts.delete(providerName);
          let actualReleased = 0;
          const staleKeys: string[] = [];
          for (const [u, p] of this.ownedUris) {
            if (p === providerName) staleKeys.push(u);
          }
          for (const key of staleKeys) {
            const provider = this.ownedUris.get(key);
            if (provider !== undefined) {
              actualReleased++;
              this.safeReport({
                type: 'store.ownership.released',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                uri: key,
                provider,
              });
            }
            this.ownedUris.delete(key);
          }

          this.safeReport({
            type: 'store.releaseOwnership',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            providerName,
            releasedKeys: actualReleased,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `releaseOwnership wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        this.reentrant--;
      }
    };

    /* — setFolderAggregate() — */
    this.store.setFolderAggregate = (uri: Uri, state: ProblemState): boolean => {
      if (this.disposed) return this.originalSetFolderAggregate(uri, state);
      if (this.reentrant > 0) { this.nestedEventsSkipped++; return this.originalSetFolderAggregate(uri, state); }

      if (!uri) {
        this.safeReportAssertion('nullUri', 'setFolderAggregate() called with null/undefined URI');
        return this.originalSetFolderAggregate(uri, state);
      }
      if (state == null) {
        this.safeReportAssertion('nullState', 'setFolderAggregate() called with null/undefined state');
        return this.originalSetFolderAggregate(uri, state);
      }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const uriStr = uri.toString();
        const stateBefore = this.store.get(uri);

        const accepted = this.originalSetFolderAggregate(uri, state);
        const executionTimeMs = Date.now() - start;

        const stateAfter = this.store.get(uri);

        try {
          this.safeReport({
            type: 'store.setFolderAggregate',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            uri: uriStr,
            stateBefore,
            stateAfter,
            accepted,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `setFolderAggregate wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          this.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
        return accepted;
      } finally {
        this.reentrant--;
      }
    };

    /* — deleteByPrefix() — */
    this.store.deleteByPrefix = (prefix: string): number => {
      if (this.disposed) return this.originalDeleteByPrefix(prefix);
      if (this.reentrant > 0) { this.nestedEventsSkipped++; return this.originalDeleteByPrefix(prefix); }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        const deletedCount = this.originalDeleteByPrefix(prefix);
        const executionTimeMs = Date.now() - start;

        try {
          /* Clear ownership tracking for all matching entries */
          const prefixSlash = prefix + '/';
          const staleKeys: string[] = [];
          for (const key of this.ownedUris.keys()) {
            if (key === prefix || key.startsWith(prefixSlash)) {
              staleKeys.push(key);
            }
          }
          for (const key of staleKeys) {
            const provider = this.ownedUris.get(key);
            if (provider !== undefined) {
              this.decrementOwnerCount(provider);
              this.safeReport({
                type: 'store.ownership.released',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                uri: key,
                provider,
              });
            }
            this.ownedUris.delete(key);
          }

          this.safeReport({
            type: 'store.deleteByPrefix',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            prefix,
            deletedCount,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `deleteByPrefix wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
        return deletedCount;
      } finally {
        this.reentrant--;
      }
    };

    /* — movePrefix() — */
    this.store.movePrefix = (oldPrefix: string, newPrefix: string): number => {
      if (this.disposed) return this.originalMovePrefix(oldPrefix, newPrefix);
      if (this.reentrant > 0) { this.nestedEventsSkipped++; return this.originalMovePrefix(oldPrefix, newPrefix); }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        const movedCount = this.originalMovePrefix(oldPrefix, newPrefix);
        const executionTimeMs = Date.now() - start;

        try {
          /* Re-key ownership tracking for moved entries */
          if (oldPrefix !== newPrefix) {
            const oldPrefixSlash = oldPrefix + '/';
            const rekey: [string, string, string][] = [];
          for (const [key, provider] of this.ownedUris) {
              if (key === oldPrefix || key.startsWith(oldPrefixSlash)) {
                const newKey = newPrefix + key.slice(oldPrefix.length);
                rekey.push([key, newKey, provider]);
              }
            }
            for (const [oldKey, newKey, provider] of rekey) {
              this.ownedUris.delete(oldKey);
              this.ownedUris.set(newKey, provider);
              this.safeReport({
                type: 'store.ownership.moved',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                oldUri: oldKey,
                newUri: newKey,
                provider,
              });
            }
          }

          this.safeReport({
            type: 'store.movePrefix',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            oldPrefix,
            newPrefix,
            movedCount,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `movePrefix wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
        return movedCount;
      } finally {
        this.reentrant--;
      }
    };

    /* — unconfigureProvider() — */
    this.store.unconfigureProvider = (providerName: string): void => {
      if (this.disposed) { this.originalUnconfigureProvider(providerName); return; }
      if (this.reentrant > 0) { this.nestedEventsSkipped++; this.originalUnconfigureProvider(providerName); return; }

      this.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        this.originalUnconfigureProvider(providerName);
        const executionTimeMs = Date.now() - start;

        try {
          /* Clean up ownership tracking for this provider */
          this.ownerCounts.delete(providerName);
          const staleKeys: string[] = [];
          for (const [u, p] of this.ownedUris) {
            if (p === providerName) staleKeys.push(u);
          }
          for (const key of staleKeys) {
            this.safeReport({
              type: 'store.ownership.released',
              timestamp: start,
              traceId,
              source: 'StoreMonitor',
              uri: key,
              provider: providerName,
            });
            this.ownedUris.delete(key);
          }

          this.safeReport({
            type: 'store.unconfigureProvider',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            providerName,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          this.safeReportAssertion('telemetryException', `unconfigureProvider wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        this.reentrant--;
      }
    };

    /* — dispose() — */
    this.store.dispose = (): void => {
      if (this.disposed) { this.originalDispose(); return; }

      this.disposed = true;

      const entryCount = this.store.size();
      const traceId = generateTraceId();
      const timestamp = Date.now();

      this.safeReport({
        type: 'store.dispose',
        timestamp,
        traceId,
        source: 'StoreMonitor',
        entryCount,
        totalWrites: this.totalWrites,
        totalRejected: this.totalRejected,
        totalOwnershipConflicts: this.totalOwnershipConflicts,
        batchCount: this.batchCount,
      });

      /* restore all original methods */
      this.store.set = this.originalSet;
      this.store.delete = this.originalDelete;
      this.store.clear = this.originalClear;
      this.store.beginBatch = this.originalBeginBatch;
      this.store.endBatch = this.originalEndBatch;
      this.store.configureProvider = this.originalConfigureProvider;
      this.store.releaseOwnership = this.originalReleaseOwnership;
      this.store.setFolderAggregate = this.originalSetFolderAggregate;
      this.store.deleteByPrefix = this.originalDeleteByPrefix;
      this.store.movePrefix = this.originalMovePrefix;
      this.store.unconfigureProvider = this.originalUnconfigureProvider;
      this.store.dispose = this.originalDispose;

      this.originalDispose();
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
  ): { reason: 'ownership' | 'unchanged' | 'unknown'; detail: string } {
    /* Mirror ProblemStore.set() decision order: ownership first (strictly lower priority), then unchanged */
    if (providerName !== undefined && ownerBefore !== undefined && ownerBefore !== providerName) {
      const ownerPriority = this.store.getProviderPriority(ownerBefore);
      const requesterPriority = this.store.getProviderPriority(providerName);
      if (requesterPriority < ownerPriority) {
        return {
          reason: 'ownership',
          detail: `Provider "${providerName}" (priority ${requesterPriority}) lower than current owner "${ownerBefore}" (priority ${ownerPriority})`,
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
    const now = Date.now();
    if (now - this.lastAssertionTime < 500) return;
    this.lastAssertionTime = now;
    this.runAssertions();
  }

  private runAssertions(): void {
    try {
      let entryCount = 0;
      let negativeCounts = 0;
      let badSeverity = 0;
      const fileKeys: string[] = [];

      this.store.forEachEntry((key, state, isFolder) => {
        entryCount++;
        if (!isFolder) fileKeys.push(key);
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
        this.safeReportAssertion('totals', `Negative running totals: ${totals.errorCount}e/${totals.warningCount}w/${totals.infoCount}i`);
      }

      if (negativeCounts > 0) {
        this.safeReportAssertion('negativeCounts', `${negativeCounts} entries have negative counts`);
      }

      if (badSeverity > 0) {
        this.safeReportAssertion('invalidSeverity', `${badSeverity} entries have invalid severity`);
      }

      /* Check store size sanity */
      if (entryCount !== this.store.size()) {
        this.safeReportAssertion('sizeMismatch', `forEachEntry yielded ${entryCount} entries but size() returns ${this.store.size()}`);
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
          this.safeReportAssertion('ownerMissing', `${missingOwner} file entries have no tracked owner`);
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
          this.safeReportAssertion('staleOwnership', `${staleEntries} ownedUris entries are not in the store`);
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
          this.safeReportAssertion('emptyFolderAggregate', `${orphanFolders} folder aggregates have no file children`);
        }
      }
    } catch (err) {
      this.safeReportAssertion('exception', `Assertion threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Report a telemetry event without ever throwing.
   * Used inside wrapper bodies so reporter failures cannot leak the reentrant counter.
   */
  private safeReport(event: any): void {
    try {
      this.reporter.report(event);
    } catch {
      /* swallow — telemetry must never break the store */
    }
  }

  /**
   * Report an assertion failure without ever throwing.
   * Used in catch blocks where the reporter itself may be the source of failure.
   */
  private safeReportAssertion(assertion: string, detail: string): void {
    try {
      this.reporter.report({
        type: 'store.assertion.failure',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'StoreMonitor',
        assertion,
        detail,
      } as any);
    } catch {
      /* swallow */
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Performance snapshot                                               */
  /* ------------------------------------------------------------------ */

  capturePerformanceSnapshot(): void {
    const traceId = generateTraceId();
    const avg = this.setDurationCount > 0 ? this.setDurationSum / this.setDurationCount : 0;

    this.safeReport({
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
      nestedEventsSkipped: this.nestedEventsSkipped,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Expose internal state structure sizes for diagnostics */
  getInternalStateSizes(): Record<string, number> {
    return {
      ownedUris: this.ownedUris.size,
      ownerCounts: this.ownerCounts.size,
      batchStateStack: this.batchStateStack.length,
    };
  }

  dispose(): void {
    if (this.disposed) return;

    /* emit final event before restoring originals */
    const traceId = generateTraceId();
    this.safeReport({
      type: 'store.dispose',
      timestamp: Date.now(),
      traceId,
      source: 'StoreMonitor',
      entryCount: this.store.size(),
      totalWrites: this.totalWrites,
      totalRejected: this.totalRejected,
      totalOwnershipConflicts: this.totalOwnershipConflicts,
      batchCount: this.batchCount,
    });

    this.disposed = true;
    this.store.set = this.originalSet;
    this.store.delete = this.originalDelete;
    this.store.clear = this.originalClear;
    this.store.beginBatch = this.originalBeginBatch;
    this.store.endBatch = this.originalEndBatch;
    this.store.configureProvider = this.originalConfigureProvider;
    this.store.releaseOwnership = this.originalReleaseOwnership;
    this.store.setFolderAggregate = this.originalSetFolderAggregate;
    this.store.deleteByPrefix = this.originalDeleteByPrefix;
    this.store.movePrefix = this.originalMovePrefix;
    this.store.unconfigureProvider = this.originalUnconfigureProvider;
    this.store.dispose = this.originalDispose;
  }
}

/** Create a StoreMonitor for the given ProblemStore */
export function createStoreMonitor(
  store: ProblemStore,
  reporter: TelemetryReporter,
): StoreMonitor {
  return new StoreMonitor(store, reporter);
}