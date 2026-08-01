import { Uri } from 'vscode';
import { ScanJobRequest } from './ScanJob';

/**
 * # Dispatcher — the execution unit of the ScanScheduler redesign.
 *
 * Extracted (T2) from `ScanScheduler.refreshWithLocks` /
 * `refreshOneWithLock`. Owns the **per‑provider serialization lock** and the
 * actual provider invocation. The scheduler hands it a ready job; the
 * dispatcher runs it and reports the outcome.
 *
 * ## Invariants preserved from the legacy scheduler
 * - **≤1 in‑flight scan per provider** (INV‑1): a Promise‑chain lock per
 *   provider serializes same‑provider scans. While provider P's lock is held,
 *   a second request for P waits in the chain.
 * - **Different providers run concurrently**: `Promise.all` across providers.
 * - **Cooperative cancellation**: each job carries an `AbortSignal`; if it
 *   fires while waiting for the lock, the scan is skipped.
 *
 * ## Why it's a separate class
 * - The scheduler's job is *scheduling* (when/whether to run). The
 *   dispatcher's job is *execution* (how to run safely). Splitting them lets
 *   each be tested in isolation and lets T3 swap the queue without touching
 *   execution semantics.
 * - The lock map lifetime is independent of any single job: a provider's lock
 *   chain persists across many jobs, so it must live somewhere that isn't
 *   recreated per scan.
 */

/** Minimal refresh surface the dispatcher needs (DI seam for testing). */
export interface DispatcherRefreshFn {
  /**
   * Refresh a set of providers for the given URIs. Resolves when all providers
   * finish (success or failure). Never throws — failures are reported per
   * provider via the returned result so the dispatcher can attribute them.
   */
  (providerNames: readonly string[], uris: readonly Uri[]): Promise<void>;
}

/** Outcome of executing one job. */
export interface ExecutionResult {
  readonly success: boolean;
  readonly executionTimeMs: number;
  readonly error?: Error;
}

/** Listener for dispatcher transitions (monitor + tests). */
export interface DispatcherListener {
  onProviderStart?(provider: string): void;
  onProviderFinish?(provider: string, executionTimeMs: number, success: boolean, error?: Error): void;
}

export class Dispatcher {
  /** Per‑provider Promise chain — serializes same‑provider scans (INV‑1). */
  private readonly _locks = new Map<string, Promise<void>>();
  /** Providers currently executing (for `isRunning` / cancellation queries). */
  private readonly _running = new Set<string>();
  private readonly _refresh: DispatcherRefreshFn;
  private readonly _log: (msg: string) => void;
  private readonly _listener?: DispatcherListener;
  private _disposed = false;

  constructor(
    refresh: DispatcherRefreshFn,
    log: (msg: string) => void,
    listener?: DispatcherListener,
  ) {
    this._refresh = refresh;
    this._log = log;
    this._listener = listener;
  }

  /**
   * Execute a ready job: refresh each of its providers, each through its own
   * per‑provider lock. Different providers run concurrently (Promise.all);
   * same‑provider scans serialize on that provider's lock chain.
   *
   * If the job's abort signal is already fired on entry, the job is a no‑op.
   * If it fires while waiting for a lock, that provider's scan is skipped.
   *
   * Never rejects — a failed provider is recorded in the result. The whole
   * job is marked failed only if at least one provider threw.
   */
  async execute(request: ScanJobRequest, signal: AbortSignal): Promise<ExecutionResult> {
    this.ensureNotDisposed();
    const { providerNames } = request;
    const uris = request.uris ?? [];
    const start = Date.now();

    if (signal.aborted) {
      this._log(`[DISPATCHER] skipped aborted job for [${providerNames.join(', ')}]`);
      return { success: true, executionTimeMs: 0 };
    }

    const tasks = providerNames.map((name) => this.runOne(name, uris, signal));
    const outcomes = await Promise.all(tasks);

    const executionTimeMs = Date.now() - start;
    const failure = outcomes.find((o) => !o.success);
    return {
      success: !failure,
      executionTimeMs,
      error: failure?.error,
    };
  }

  /** Refresh a single provider, acquiring its per‑provider lock. */
  private async runOne(
    name: string,
    uris: readonly Uri[],
    signal: AbortSignal,
  ): Promise<{ success: boolean; error?: Error }> {
    // Chain onto any in‑flight scan for this provider. The chain is the lock:
    // while `prev` is unresolved, this scan waits.
    const prev = this._locks.get(name) ?? Promise.resolve();
    const next = prev.then(async () => {
      // Cancellation: if aborted while waiting for the lock, skip.
      if (signal.aborted) {
        this._log(`[DISPATCHER] ${name}: skipped (aborted while waiting for lock)`);
        return { success: true };
      }
      this._running.add(name);
      const providerStart = Date.now();
      this._listener?.onProviderStart?.(name);
      try {
        await this._refresh([name], uris);
        const ms = Date.now() - providerStart;
        this._listener?.onProviderFinish?.(name, ms, true);
        return { success: true };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this._log(`[DISPATCHER] ${name}: refresh failed: ${err.message}`);
        const ms = Date.now() - providerStart;
        this._listener?.onProviderFinish?.(name, ms, false, err);
        return { success: false, error: err };
      } finally {
        this._running.delete(name);
      }
    });
    // Install the chain as the new lock tail BEFORE awaiting so concurrent
    // submitters chain onto us. (Mirrors the legacy scheduler ordering.)
    this._locks.set(name, next.then(() => undefined, () => undefined));
    return next;
  }

  /** True while a scan for `provider` is executing (lock held). */
  isRunning(provider: string): boolean {
    return this._running.has(provider);
  }

  /** Number of providers currently executing. */
  get runningCount(): number {
    return this._running.size;
  }

  /** Drop all lock state. Call only when no jobs are in flight. */
  dispose(): void {
    this._disposed = true;
    this._locks.clear();
    this._running.clear();
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('Dispatcher is disposed');
    }
  }
}
