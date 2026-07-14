import { Memento } from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { TREND_STORAGE_KEY, TREND_INTERVAL_MS, MAX_TREND_SNAPSHOTS } from '../core/constants';

export interface TrendSnapshot {
  timestamp: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export interface StorageProvider {
  get<T>(_key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const defaultStorageProvider: StorageProvider = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
  update: (_key: string, _value: unknown): Thenable<void> => Promise.resolve(),
};

/** Periodically captures diagnostic totals and persists the history for trend visualization. */
export class TrendTracker {
  private readonly maxSnapshots: number;
  private readonly intervalMs: number;
  private readonly storageKey: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly storage: StorageProvider;

  constructor(
    private readonly store: ProblemStore,
    storage?: StorageProvider,
    options?: {
      maxSnapshots?: number;
      intervalMs?: number;
      storageKey?: string;
    },
  ) {
    this.storage = storage ?? defaultStorageProvider;
    this.maxSnapshots = options?.maxSnapshots ?? MAX_TREND_SNAPSHOTS;
    this.intervalMs = options?.intervalMs ?? TREND_INTERVAL_MS;
    this.storageKey = options?.storageKey ?? TREND_STORAGE_KEY;
  }

  /** Take an immediate snapshot of current diagnostic totals and persist it. */
  takeSnapshot(): void {
    const totals = this.store.computeTotals();
    const history = this.getHistory();
    history.push({
      timestamp: Date.now(),
      errorCount: totals.errorCount,
      warningCount: totals.warningCount,
      infoCount: totals.infoCount,
    });
    if (history.length > this.maxSnapshots) {
      history.splice(0, history.length - this.maxSnapshots);
    }
    this.storage.update(this.storageKey, history);
  }

  /** Retrieve the stored trend history. */
  getHistory(): TrendSnapshot[] {
    return this.storage.get<TrendSnapshot[]>(this.storageKey, []);
  }

  /** Start periodic snapshots. Call on activation. */
  start(): void {
    this.takeSnapshot();
    this.timer = setInterval(() => this.takeSnapshot(), this.intervalMs);
  }

  /** Stop periodic snapshots. Call on deactivation. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Returns true if the tracker is actively running. */
  get running(): boolean {
    return this.timer !== undefined;
  }
}

/** Adapts VS Code's `Memento` to the `StorageProvider` interface. */
export class MementoStorageProvider implements StorageProvider {
  constructor(private readonly memento: Memento) {}

  get<T>(key: string, defaultValue: T): T {
    return this.memento.get(key, defaultValue);
  }

  update(key: string, value: unknown): Thenable<void> {
    return this.memento.update(key, value);
  }
}
