import { ProblemStore } from '../../store/ProblemStore';
import { ProblemStoreChange } from '../../models/ProblemStoreChange';
import { ProblemState, ProblemSeverity } from '../../core/types';
import { normalizeUriKey } from '../../core/uriKey';
import { TelemetryReporter } from '../../telemetry';
import { generateTraceId } from '../../telemetry';

/** Structured event payload for a store.set() telemetry event */
export interface StoreSetEventData {
  readonly type: 'store.set';
  readonly uri: string;
  readonly oldState: ProblemState | undefined;
  readonly newState: ProblemState | undefined;
  readonly provider: string | undefined;
  readonly priority: number | undefined;
  readonly executionTimeMs: number;
  readonly returnValue: boolean;
}

/** Structured event payload for a store.delete() telemetry event */
export interface StoreDeleteEventData {
  readonly type: 'store.delete';
  readonly uri: string;
  readonly oldState: ProblemState | undefined;
  readonly provider: string | undefined;
  readonly executionTimeMs: number;
  readonly returnValue: boolean;
}

/** Structured event payload for a store.clear() telemetry event */
export interface StoreClearEventData {
  readonly type: 'store.clear';
  readonly previousEntryCount: number;
  readonly previousOwners: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for a store.batch event */
export interface StoreBatchEventData {
  readonly type: 'store.batch';
  readonly executionTimeMs: number;
}

/** Structured event payload for store.prefixDeleted event */
export interface StorePrefixDeletedEventData {
  readonly type: 'store.prefixDeleted';
  readonly prefix: string;
  readonly executionTimeMs: number;
}

/** Structured event payload for store.prefixMoved event */
export interface StorePrefixMovedEventData {
  readonly type: 'store.prefixMoved';
  readonly oldPrefix: string;
  readonly newPrefix: string;
  readonly executionTimeMs: number;
}

/** Structured event payload for a rejected write telemetry event */
export interface StoreRejectedWriteEventData {
  readonly type: 'store.rejectedWrite';
  readonly uri: string;
  readonly newState: ProblemState;
  readonly provider: string;
  readonly currentOwner: string | undefined;
  readonly providerPriority: number;
  readonly ownerPriority: number;
}

/** Structured event payload for an ownership change telemetry event */
export interface StoreOwnershipChangeEventData {
  readonly type: 'store.ownershipChange';
  readonly uri: string | undefined;
  readonly provider: string;
  readonly action: 'acquired' | 'released' | 'transferred';
  readonly previousOwner: string | undefined;
}

/** Union of all store monitor event types */
export type StoreMonitorEvent =
  | StoreSetEventData
  | StoreDeleteEventData
  | StoreClearEventData
  | StoreBatchEventData
  | StorePrefixDeletedEventData
  | StorePrefixMovedEventData
  | StoreRejectedWriteEventData
  | StoreOwnershipChangeEventData;

/** Monitors ProblemStore operations and publishes structured telemetry events */
export class StoreMonitor {
  private shadow = new Map<string, ProblemState>();
  private shadowOwners = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly store: ProblemStore,
    private readonly reporter: TelemetryReporter
  ) {
    this.syncShadow();
    this.store.onDidChange((change) => {
      if (this.disposed) return;
      try {
        this.handleChange(change);
      } catch (err) {
        this.reporter.report({
          type: 'error',
          timestamp: Date.now(),
          traceId: generateTraceId(),
          source: 'StoreMonitor',
          error: err instanceof Error ? err.message : String(err),
          operation: 'handleChange',
        } as any);
      }
    });
  }

  private syncShadow(): void {
    this.shadow.clear();
    this.shadowOwners.clear();
    this.store.forEachEntry((key, state) => {
      this.shadow.set(key, state);
    });
  }

  private handleChange(change: ProblemStoreChange): void {
    const startTime = Date.now();
    const traceId = generateTraceId();
    const source = 'StoreMonitor';

    switch (change.kind) {
      case 'added': {
        const key = normalizeUriKey(change.uri);
        const oldState = this.shadow.get(key);
        const newState = this.store.get(change.uri);
        const provider = this.store.getOwningProvider(change.uri);
        const priority = provider !== undefined ? this.store.getProviderPriority(provider) : undefined;
        const durationMs = Date.now() - startTime;

        this.shadow.set(key, newState ?? oldState ?? { severity: ProblemSeverity.None, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0 });
        if (provider !== undefined) {
          this.trackOwnershipChange(key, provider, 'acquired', undefined);
        }

        this.reporter.report({
          type: 'store.set',
          timestamp: Date.now(),
          traceId,
          source,
          uri: change.uri.toString(),
          oldState: oldState ?? undefined,
          newState: newState ?? undefined,
          provider,
          priority,
          executionTimeMs: durationMs,
          returnValue: true,
          operation: 'added',
        } as any);
        break;
      }

      case 'updated': {
        const key = normalizeUriKey(change.uri);
        const oldState = this.shadow.get(key);
        const newState = this.store.get(change.uri);
        const provider = this.store.getOwningProvider(change.uri);
        const priority = provider !== undefined ? this.store.getProviderPriority(provider) : undefined;
        const durationMs = Date.now() - startTime;

        this.shadow.set(key, newState ?? oldState ?? { severity: ProblemSeverity.None, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0 });
        if (provider !== undefined) {
          const previousOwner = this.shadowOwners.get(key);
          if (previousOwner !== provider) {
            this.trackOwnershipChange(key, provider, 'transferred', previousOwner);
          }
        }

        this.reporter.report({
          type: 'store.set',
          timestamp: Date.now(),
          traceId,
          source,
          uri: change.uri.toString(),
          oldState: oldState ?? undefined,
          newState: newState ?? undefined,
          provider,
          priority,
          executionTimeMs: durationMs,
          returnValue: true,
          operation: 'updated',
        } as any);
        break;
      }

      case 'removed': {
        const key = normalizeUriKey(change.uri);
        const oldState = this.shadow.get(key);
        const provider = this.shadowOwners.get(key);
        const durationMs = Date.now() - startTime;

        this.shadow.delete(key);
        this.shadowOwners.delete(key);

        this.reporter.report({
          type: 'store.delete',
          timestamp: Date.now(),
          traceId,
          source,
          uri: change.uri.toString(),
          oldState: oldState ?? undefined,
          provider,
          executionTimeMs: durationMs,
          returnValue: true,
        } as any);
        break;
      }

      case 'cleared': {
        const entryCount = this.shadow.size;
        const ownerCount = this.shadowOwners.size;
        const durationMs = Date.now() - startTime;

        this.shadow.clear();
        this.shadowOwners.clear();

        this.reporter.report({
          type: 'store.clear',
          timestamp: Date.now(),
          traceId,
          source,
          previousEntryCount: entryCount,
          previousOwners: ownerCount,
          executionTimeMs: durationMs,
        } as any);
        break;
      }

      case 'batch': {
        const durationMs = Date.now() - startTime;
        this.reporter.report({
          type: 'store.batch',
          timestamp: Date.now(),
          traceId,
          source,
          executionTimeMs: durationMs,
        } as any);
        break;
      }

      case 'prefixDeleted': {
        const durationMs = Date.now() - startTime;
        this.reporter.report({
          type: 'store.prefixDeleted',
          timestamp: Date.now(),
          traceId,
          source,
          prefix: change.prefix,
          executionTimeMs: durationMs,
        } as any);
        break;
      }

      case 'prefixMoved': {
        const durationMs = Date.now() - startTime;
        this.reporter.report({
          type: 'store.prefixMoved',
          timestamp: Date.now(),
          traceId,
          source,
          oldPrefix: change.oldPrefix,
          newPrefix: change.newPrefix,
          executionTimeMs: durationMs,
        } as any);
        break;
      }
    }
  }

  private trackOwnershipChange(uriKey: string, provider: string, action: 'acquired' | 'released' | 'transferred', previousOwner: string | undefined): void {
    this.reporter.report({
      type: 'store.ownershipChange',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'StoreMonitor',
      uri: uriKey,
      provider,
      action,
      previousOwner,
    } as any);

    if (action === 'acquired' || action === 'transferred') {
      this.shadowOwners.set(uriKey, provider);
    } else {
      this.shadowOwners.delete(uriKey);
    }
  }

  /** Dispose the monitor (unsubscribes from store events) */
  dispose(): void {
    this.disposed = true;
    this.shadow.clear();
    this.shadowOwners.clear();
  }
}

/** Create a StoreMonitor attached to the given store and reporter */
export function createStoreMonitor(store: ProblemStore, reporter: TelemetryReporter): StoreMonitor {
  return new StoreMonitor(store, reporter);
}