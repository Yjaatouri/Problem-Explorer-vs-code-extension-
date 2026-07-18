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

  /* ownership tracking */
  private ownerCounts = new Map<string, number>();
  private ownedUris = new Map<string, string>();

  /* reentrancy guard — prevents recursive telemetry if an event subscriber calls back into the store */
  private reentrant = 0;

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
    const self = this;

    /* — set() — */
    this.store.set = function (uri: Uri, state: ProblemState, providerName?: string): boolean {
      if (self.disposed) return self.originalSet(uri, state, providerName);
      if (self.reentrant > 0) return self.originalSet(uri, state, providerName);

      if (!uri) {
        self.safeReportAssertion('nullUri', 'set() called with null/undefined URI');
        return self.originalSet(uri, state, providerName);
      }
      if (state == null) {
        self.safeReportAssertion('nullState', 'set() called with null/undefined state');
        return self.originalSet(uri, state, providerName);
      }

      self.reentrant++;
      try {
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

        try {
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

            self.safeReport({
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

            /* Ownership tracking */
            if (providerName !== undefined) {
              if (!ownerBefore) {
                self.ownerCounts.set(providerName, (self.ownerCounts.get(providerName) ?? 0) + 1);
                self.ownedUris.set(normKey, providerName);
                self.safeReport({
                  type: 'store.ownership.acquired',
                  timestamp: start,
                  traceId,
                  source: 'StoreMonitor',
                  uri: uriStr,
                  provider: providerName,
                  priority: self.store.getProviderPriority(providerName),
                });
              } else if (ownerBefore !== providerName) {
                self.totalOwnershipConflicts++;
                if (self.batchStartTime > 0) self.batchConflictCount++;
                self.decrementOwnerCount(ownerBefore);
                self.ownerCounts.set(providerName, (self.ownerCounts.get(providerName) ?? 0) + 1);
                self.ownedUris.set(normKey, providerName);
                self.safeReport({
                  type: 'store.ownership.transferred',
                  timestamp: start,
                  traceId,
                  source: 'StoreMonitor',
                  uri: uriStr,
                  fromProvider: ownerBefore,
                  toProvider: providerName,
                  fromPriority: self.store.getProviderPriority(ownerBefore),
                  toPriority: self.store.getProviderPriority(providerName),
                });
              }
            }
          } else {
            self.totalRejected++;
            if (self.batchStartTime > 0) self.batchRejectedCount++;

            /* Determine rejection reason */
            let reason: { reason: 'ownership' | 'unchanged' | 'unknown'; detail: string };
            try {
              reason = self.determineRejectReason(providerName, ownerBefore, state, stateBefore);
            } catch (reasonErr) {
              reason = { reason: 'unknown', detail: `determineRejectReason threw: ${reasonErr instanceof Error ? reasonErr.message : String(reasonErr)}` };
            }
            self.safeReport({
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
            });

            /* Ownership rejection event */
            if (reason.reason === 'ownership' && ownerBefore && providerName) {
              self.safeReport({
                type: 'store.ownership.rejected',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                uri: uriStr,
                requester: providerName,
                currentOwner: ownerBefore,
                requesterPriority: self.store.getProviderPriority(providerName),
                currentOwnerPriority: self.store.getProviderPriority(ownerBefore),
              });
            }
          }
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `set wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          self.sampleAssertions();
        } catch {
          /* sampleAssertions already self-protects; swallow defensively */
        }
        return accepted;
      } finally {
        self.reentrant--;
      }
    };

    /* — delete() — */
    this.store.delete = function (uri: Uri): boolean {
      if (self.disposed) return self.originalDelete(uri);
      if (self.reentrant > 0) return self.originalDelete(uri);

      if (!uri) {
        self.safeReportAssertion('nullUri', 'delete() called with null/undefined URI');
        return self.originalDelete(uri);
      }

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const uriStr = uri.toString();
        const normKey = normalizeUriKey(uri);
        const stateBefore = self.store.get(uri);
        const ownerBefore = self.store.getOwningProvider(uri);

        const accepted = self.originalDelete(uri);
        const executionTimeMs = Date.now() - start;

        try {
          self.safeReport({
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
            self.decrementOwnerCount(ownerBefore);
            self.ownedUris.delete(normKey);
            self.safeReport({
              type: 'store.ownership.released',
              timestamp: start,
              traceId,
              source: 'StoreMonitor',
              uri: uriStr,
              provider: ownerBefore,
            });
          }
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `delete wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          self.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
        return accepted;
      } finally {
        self.reentrant--;
      }
    };

    /* — clear() — */
    this.store.clear = function (): void {
      if (self.disposed) { self.originalClear(); return; }
      if (self.reentrant > 0) { self.originalClear(); return; }

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const entryCountBefore = self.store.size();

        self.originalClear();
        const executionTimeMs = Date.now() - start;

        try {
          /* Reset all monitor state to reflect empty store */
          self.totalWrites = 0;
          self.totalRejected = 0;
          self.totalOwnershipConflicts = 0;
          self.setDurationSum = 0;
          self.setDurationCount = 0;
          self.batchCount = 0;
          self.batchStartTime = 0;
          self.batchWriteCount = 0;
          self.batchRejectedCount = 0;
          self.batchConflictCount = 0;
          self.ownerCounts.clear();
          self.ownedUris.clear();

          self.safeReport({
            type: 'store.clear',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            entryCountBefore,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `clear wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          self.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
      } finally {
        self.reentrant--;
      }
    };

    /* — beginBatch() — */
    this.store.beginBatch = function (): void {
      if (self.disposed) { self.originalBeginBatch(); return; }
      if (self.reentrant > 0) { self.originalBeginBatch(); return; }

      self.reentrant++;
      try {
        const traceId = generateTraceId();
        self.batchStartTime = Date.now();
        self.batchWriteCount = 0;
        self.batchRejectedCount = 0;
        self.batchConflictCount = 0;

        self.originalBeginBatch();

        try {
          self.safeReport({
            type: 'store.beginBatch',
            timestamp: self.batchStartTime,
            traceId,
            source: 'StoreMonitor',
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `beginBatch wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        self.reentrant--;
      }
    };

    /* — endBatch() — */
    this.store.endBatch = function (): void {
      if (self.disposed) { self.originalEndBatch(); return; }
      if (self.reentrant > 0) { self.originalEndBatch(); return; }

      self.reentrant++;
      try {
        const traceId = generateTraceId();
        const now = Date.now();
        const durationMs = self.batchStartTime > 0 ? now - self.batchStartTime : 0;
        const writes = self.batchWriteCount;
        const rejectedWrites = self.batchRejectedCount;
        const ownershipConflicts = self.batchConflictCount;

        self.originalEndBatch();

        try {
          self.batchCount++;
          self.batchStartTime = 0;

          self.safeReport({
            type: 'store.endBatch',
            timestamp: now,
            traceId,
            source: 'StoreMonitor',
            writes,
            rejectedWrites,
            ownershipConflicts,
            durationMs,
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `endBatch wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          self.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
      } finally {
        self.reentrant--;
      }
    };

    /* — configureProvider() — */
    this.store.configureProvider = function (providerName: string, priority: number): void {
      if (self.disposed) { self.originalConfigureProvider(providerName, priority); return; }
      if (self.reentrant > 0) { self.originalConfigureProvider(providerName, priority); return; }

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        self.originalConfigureProvider(providerName, priority);
        const executionTimeMs = Date.now() - start;

        try {
          self.safeReport({
            type: 'store.configureProvider',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            providerName,
            priority,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `configureProvider wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        self.reentrant--;
      }
    };

    /* — releaseOwnership() — */
    this.store.releaseOwnership = function (providerName: string): void {
      if (self.disposed) { self.originalReleaseOwnership(providerName); return; }
      if (self.reentrant > 0) { self.originalReleaseOwnership(providerName); return; }

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const releasedCount = self.ownerCounts.get(providerName) ?? 0;

        self.originalReleaseOwnership(providerName);
        const executionTimeMs = Date.now() - start;

        try {
          /* Reset ownership tracking for this provider */
          self.ownerCounts.delete(providerName);
          const staleKeys: string[] = [];
          for (const [u, p] of self.ownedUris) {
            if (p === providerName) staleKeys.push(u);
          }
          for (const key of staleKeys) {
            const provider = self.ownedUris.get(key);
            if (provider !== undefined) {
              self.safeReport({
                type: 'store.ownership.released',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                uri: key,
                provider,
              });
            }
            self.ownedUris.delete(key);
          }

          self.safeReport({
            type: 'store.releaseOwnership',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            providerName,
            releasedKeys: releasedCount,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `releaseOwnership wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        self.reentrant--;
      }
    };

    /* — setFolderAggregate() — */
    this.store.setFolderAggregate = function (uri: Uri, state: ProblemState): boolean {
      if (self.disposed) return self.originalSetFolderAggregate(uri, state);
      if (self.reentrant > 0) return self.originalSetFolderAggregate(uri, state);

      if (!uri) {
        self.safeReportAssertion('nullUri', 'setFolderAggregate() called with null/undefined URI');
        return self.originalSetFolderAggregate(uri, state);
      }
      if (state == null) {
        self.safeReportAssertion('nullState', 'setFolderAggregate() called with null/undefined state');
        return self.originalSetFolderAggregate(uri, state);
      }

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();
        const uriStr = uri.toString();
        const stateBefore = self.store.get(uri);

        const accepted = self.originalSetFolderAggregate(uri, state);
        const executionTimeMs = Date.now() - start;

        const stateAfter = self.store.get(uri);

        try {
          self.safeReport({
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
          self.safeReportAssertion('telemetryException', `setFolderAggregate wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }

        try {
          self.sampleAssertions();
        } catch {
          /* swallow defensively */
        }
        return accepted;
      } finally {
        self.reentrant--;
      }
    };

    /* — deleteByPrefix() — */
    this.store.deleteByPrefix = function (prefix: string): number {
      if (self.disposed) return self.originalDeleteByPrefix(prefix);
      if (self.reentrant > 0) return self.originalDeleteByPrefix(prefix);

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        const deletedCount = self.originalDeleteByPrefix(prefix);
        const executionTimeMs = Date.now() - start;

        try {
          /* Clear ownership tracking for all matching entries */
          const prefixSlash = prefix + '/';
          const staleKeys: string[] = [];
          for (const key of self.ownedUris.keys()) {
            if (key === prefix || key.startsWith(prefixSlash)) {
              staleKeys.push(key);
            }
          }
          for (const key of staleKeys) {
            const provider = self.ownedUris.get(key);
            if (provider !== undefined) {
              self.decrementOwnerCount(provider);
              self.safeReport({
                type: 'store.ownership.released',
                timestamp: start,
                traceId,
                source: 'StoreMonitor',
                uri: key,
                provider,
              });
            }
            self.ownedUris.delete(key);
          }

          self.safeReport({
            type: 'store.deleteByPrefix',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            prefix,
            deletedCount,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `deleteByPrefix wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
        return deletedCount;
      } finally {
        self.reentrant--;
      }
    };

    /* — movePrefix() — */
    this.store.movePrefix = function (oldPrefix: string, newPrefix: string): number {
      if (self.disposed) return self.originalMovePrefix(oldPrefix, newPrefix);
      if (self.reentrant > 0) return self.originalMovePrefix(oldPrefix, newPrefix);

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        const movedCount = self.originalMovePrefix(oldPrefix, newPrefix);
        const executionTimeMs = Date.now() - start;

        try {
          /* Re-key ownership tracking for moved entries */
          if (oldPrefix !== newPrefix) {
            const oldPrefixSlash = oldPrefix + '/';
            const rekey: [string, string, string][] = [];
          for (const [key, provider] of self.ownedUris) {
              if (key === oldPrefix || key.startsWith(oldPrefixSlash)) {
                const newKey = newPrefix + key.slice(oldPrefix.length);
                rekey.push([key, newKey, provider]);
              }
            }
            for (const [oldKey, newKey, provider] of rekey) {
              self.ownedUris.delete(oldKey);
              self.ownedUris.set(newKey, provider);
              self.safeReport({
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

          self.safeReport({
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
          self.safeReportAssertion('telemetryException', `movePrefix wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
        return movedCount;
      } finally {
        self.reentrant--;
      }
    };

    /* — unconfigureProvider() — */
    this.store.unconfigureProvider = function (providerName: string): void {
      if (self.disposed) { self.originalUnconfigureProvider(providerName); return; }
      if (self.reentrant > 0) { self.originalUnconfigureProvider(providerName); return; }

      self.reentrant++;
      try {
        const start = Date.now();
        const traceId = generateTraceId();

        self.originalUnconfigureProvider(providerName);
        const executionTimeMs = Date.now() - start;

        try {
          self.safeReport({
            type: 'store.unconfigureProvider',
            timestamp: start,
            traceId,
            source: 'StoreMonitor',
            providerName,
            executionTimeMs,
          });
        } catch (telemetryErr) {
          self.safeReportAssertion('telemetryException', `unconfigureProvider wrapper: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`);
        }
      } finally {
        self.reentrant--;
      }
    };

    /* — dispose() — */
    this.store.dispose = function (): void {
      if (self.disposed) { self.originalDispose(); return; }

      const entryCount = self.store.size();
      const traceId = generateTraceId();
      const timestamp = Date.now();

      self.safeReport({
        type: 'store.dispose',
        timestamp,
        traceId,
        source: 'StoreMonitor',
        entryCount,
        totalWrites: self.totalWrites,
        totalRejected: self.totalRejected,
        totalOwnershipConflicts: self.totalOwnershipConflicts,
        batchCount: self.batchCount,
      });

      /* restore all original methods */
      self.store.set = self.originalSet;
      self.store.delete = self.originalDelete;
      self.store.clear = self.originalClear;
      self.store.beginBatch = self.originalBeginBatch;
      self.store.endBatch = self.originalEndBatch;
      self.store.configureProvider = self.originalConfigureProvider;
      self.store.releaseOwnership = self.originalReleaseOwnership;
      self.store.setFolderAggregate = self.originalSetFolderAggregate;
      self.store.deleteByPrefix = self.originalDeleteByPrefix;
      self.store.movePrefix = self.originalMovePrefix;
      self.store.unconfigureProvider = self.originalUnconfigureProvider;
      self.store.dispose = self.originalDispose;

      self.disposed = true;
      self.originalDispose();
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
    this.store.deleteByPrefix = this.originalDeleteByPrefix;
    this.store.movePrefix = this.originalMovePrefix;
    this.store.unconfigureProvider = this.originalUnconfigureProvider;
  }
}

/** Create a StoreMonitor for the given ProblemStore */
export function createStoreMonitor(
  store: ProblemStore,
  reporter: TelemetryReporter,
): StoreMonitor {
  return new StoreMonitor(store, reporter);
}