import { Uri } from 'vscode';
import {
  ScanJob,
  ScanJobRequest,
  ScanEventKind,
  ScanPriority,
  computeScanPriority,
  generateJobId,
} from './ScanJob';

/**
 * # JobQueue — the coalescing heart of the ScanScheduler redesign.
 *
 * ## Problem it solves
 * The previous scheduler keyed pending jobs on
 * `provider|uri|source|reason`, so a save and a create on the same `.ts`
 * file produced *two* jobs for the `tsc` provider → two full scans. The
 * brief is explicit: "10 saves → 1 merged scan, NOT 10 scans." TSC cannot
 * scan incrementally anyway, and ESLint gets the full unioned URI list — so
 * coalescing on **provider id** collapses any burst for one provider into a
 * single execution while preserving incremental URI sets for providers that
 * support them.
 *
 * ## Design
 * - **Coalesce key = provider id.** At most one pending slot per provider
 *   (INV‑3). New arrivals merge into the existing slot: union URIs, take max
 *   priority, keep the newest reason/timestamp.
 * - **Trailing debounce** (window `W`, from config `autoScanDelay`): the flush
 *   timer is scheduled when the *first* job for a provider arrives and is
 *   **not reset** by later arrivals. This bounds latency — a steady stream of
 *   saves cannot defer the scan forever (the flaw in a reset‑on‑every‑event
 *   trailing debounce). A `maxWait` ceiling is an additional safety bound.
 * - **Binary‑heap ready set** for O(log n) priority‑ordered draining, replacing
 *   the previous O(n) `findIndex` + `splice` array (B3).
 * - **Depth‑1 "next" slot** per provider: if a job arrives for a provider that
 *   is already `inFlight`, it is *parked* (not aborted) and flushed after the
 *   in‑flight job completes. This is the merge‑not‑abort policy (B5): we never
 *   throw away a 90%‑finished scan to start an identical one.
 *
 * The queue owns **no execution logic** and **no provider calls** — it only
 * decides *when* a job is ready and hands it off via the `onFlush` callback.
 * This keeps it pure, deterministic, and unit‑testable in isolation.
 */

/** A provider‑keyed pending slot, with debounce + merge metadata. */
interface PendingSlot {
  /** The canonical job (provider, reason, uris, priority, timestamp, jobId, signal). */
  job: ScanJob;
  /** The originating request (kept for the dispatcher: providerNames, source). */
  request: ScanJobRequest;
  /** AbortController for cooperative cancellation of this slot. */
  abort: AbortController;
  /** Debounce timer firing this slot to the ready heap (trailing, not reset). */
  timer: ReturnType<typeof setTimeout>;
  /** Safety timer that force‑flushes the slot at `createdAt + maxWaitMs`. */
  maxWaitTimer: ReturnType<typeof setTimeout>;
  /** Time the slot was first created (for maxWait accounting). */
  createdAt: number;
}

/** A job that has cleared the debounce window and is ready to execute. */
export interface ReadyEntry {
  job: ScanJob;
  request: ScanJobRequest;
  abort: AbortController;
}

/**
 * The depth‑1 "next" slot for a provider whose job is already in flight.
 * At most one per provider (enforced by `submit`).
 */
interface ParkedSlot {
  job: ScanJob;
  request: ScanJobRequest;
  abort: AbortController;
}

/** Callback handed a ready job whenever one becomes runnable. */
export type FlushHandler = (entry: ReadyEntry) => void;

/** Listener for every observable queue transition (monitor + tests). */
export interface JobQueueListener {
  /** A brand‑new pending slot was created for a provider. */
  onSubmitted(job: ScanJob, coalesceKey: string): void;
  /** A new arrival merged into an existing pending slot. */
  onMerged(existingJobId: string, incomingJobId: string, coalesceKey: string): void;
  /** A job cleared debounce and moved to the ready heap. */
  onReady(job: ScanJob, heapSize: number): void;
  /** A job was parked behind an in‑flight job for the same provider. */
  onParked(job: ScanJob, behindJobId: string): void;
  /** A pending/ready/parked job was cancelled (superseded or explicit). */
  onCancelled(job: ScanJob, reason: string): void;
}

/** Why `submit` rejected a request. */
export type SubmitOutcome =
  | { readonly kind: 'submitted'; readonly job: ScanJob }
  | { readonly kind: 'merged'; readonly job: ScanJob }
  | { readonly kind: 'parked'; readonly job: ScanJob }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Snapshot of the three queue stages, for monitoring. */
export interface JobQueueSizes {
  readonly pending: number;
  readonly ready: number;
  readonly inflight: number;
}

/**
 * Options. Defaults match the legacy scheduler so behavior is preserved
 * until T3/T8 rewire them from config.
 */
export interface JobQueueOptions {
  /** Trailing debounce window ms (scheduled on first arrival, not reset). */
  readonly debounceMs?: number;
  /** Hard latency ceiling ms; forces flush even under continuous arrivals. */
  readonly maxWaitMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 50;
const DEFAULT_MAX_WAIT_MS = 1000;

export class JobQueue {
  /** provider id → pending slot. Invariant: ≤1 entry per provider (INV‑3). */
  private readonly _pending = new Map<string, PendingSlot>();
  /** provider id → depth‑1 "next" slot, only while a job for it is in flight. */
  private readonly _parked = new Map<string, ParkedSlot>();
  /** provider ids whose job is currently being executed by the dispatcher. */
  private readonly _inFlight = new Set<string>();
  /** Min‑heap of ready entries, ordered by (priority desc, timestamp asc). */
  private _heap: ReadyEntry[] = [];

  private readonly _flush: FlushHandler;
  private readonly _listener?: JobQueueListener;
  /**
   * Debounce window ms (R1): scheduled on first arrival, not reset on merge.
   * Mutable via {@link setOptions} so config changes apply to *future* slots
   * without disturbing already‑armed timers (preserves the trailing invariant).
   */
  private _debounceMs: number;
  /**
   * Hard latency ceiling ms; forces flush even under continuous arrivals.
   * Mutable via {@link setOptions}.
   */
  private _maxWaitMs: number;
  private _disposed = false;

  constructor(
    flush: FlushHandler,
    listener?: JobQueueListener,
    options?: JobQueueOptions,
  ) {
    this._flush = flush;
    this._listener = listener;
    this._debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this._maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /**
   * Update debounce/maxWait without disturbing already‑armed timers.
   * Pending slots keep their original timers; only slots created *after* this
   * call use the new values. This preserves the trailing‑debounce invariant
   * (a config change in the middle of a burst cannot starve the in‑flight slot).
   */
  setOptions(options: { debounceMs?: number; maxWaitMs?: number }): void {
    this.ensureNotDisposed();
    if (options.debounceMs !== undefined && options.debounceMs > 0) {
      this._debounceMs = options.debounceMs;
    }
    if (options.maxWaitMs !== undefined && options.maxWaitMs > 0) {
      this._maxWaitMs = options.maxWaitMs;
    }
  }

  /** Read‑only accessors for monitors/tests. */
  getDebounceMs(): number { return this._debounceMs; }
  getMaxWaitMs(): number { return this._maxWaitMs; }

  /**
   * Submit a request. The queue computes priority, assigns a jobId, and either:
   *  - creates a new pending slot (and arms the debounce timer), or
   *  - merges into an existing pending slot for the same provider, or
   *  - parks behind an in‑flight job for the same provider.
   *
   * `providerBasePriority` is the owning provider's registry priority
   * (0–9); the queue is provider‑agnostic about *which* providers exist.
   */
  submit(
    request: ScanJobRequest,
    providerBasePriority: number,
  ): SubmitOutcome {
    this.ensureNotDisposed();
    const { providerNames } = request;
    if (providerNames.length === 0) {
      return { kind: 'rejected', reason: 'no providers' };
    }

    // The redesign coalesces on provider id. A multi‑provider request
    // (e.g. startup scanning tsc + eslint) is split: each provider gets its
    // own slot, merged independently. This preserves per‑provider
    // serialization while still letting one submit() fan out.
    if (providerNames.length === 1) {
      return this.submitOne(request, providerNames[0], providerBasePriority);
    }

    // Multi‑provider: submit each independently using its own base priority.
    // The last outcome is returned (callers rarely inspect it for multi).
    let last: SubmitOutcome = { kind: 'rejected', reason: 'no providers' };
    for (const name of providerNames) {
      last = this.submitOne(
        { ...request, providerNames: [name] },
        name,
        providerBasePriority,
      );
    }
    return last;
  }

  /** Submit for a single provider (the common path). */
  private submitOne(
    request: ScanJobRequest,
    provider: string,
    providerBasePriority: number,
  ): SubmitOutcome {
    const { reason, uris = [] } = request;
    const priority = computeScanPriority(this.sourceToTier(request), providerBasePriority);
    const now = Date.now();

    // 1) Merge into an existing pending slot for this provider.
    const pending = this._pending.get(provider);
    if (pending) {
      const mergedUris = this.unionUris(pending.job.uris, uris);
      const mergedPriority = Math.max(pending.job.priority, priority);
      const incomingJobId = generateJobId();
      // Keep the newest reason but preserve the slot's createdAt for maxWait.
      pending.job = {
        ...pending.job,
        uris: mergedUris,
        priority: mergedPriority,
        timestamp: now,
        reason: this.mergeReason(pending.job.reason, reason),
      };
      pending.request = { ...pending.request, uris: mergedUris };
      // NOTE: timer is NOT reset — trailing debounce, no starvation.
      this._listener?.onMerged(pending.job.jobId, incomingJobId, provider);
      return { kind: 'merged', job: pending.job };
    }

    // 2) Park behind an in‑flight job for this provider (merge‑not‑abort).
    if (this._inFlight.has(provider)) {
      const parked = this._parked.get(provider);
      const job: ScanJob = {
        provider,
        reason,
        uris,
        priority,
        timestamp: now,
        signal: new AbortController().signal,
        jobId: generateJobId(),
      };
      if (parked) {
        // Merge into the existing parked slot too (still depth‑1).
        const mergedUris = this.unionUris(parked.job.uris, uris);
        parked.job = {
          ...parked.job,
          uris: mergedUris,
          priority: Math.max(parked.job.priority, priority),
          timestamp: now,
          reason: this.mergeReason(parked.job.reason, reason),
        };
        parked.request = { ...parked.request, uris: mergedUris };
      } else {
        const abort = new AbortController();
        const newJob: ScanJob = { ...job, signal: abort.signal };
        this._parked.set(provider, { job: newJob, request: { ...request, uris }, abort });
        // Find the in‑flight job id for the behindJobId hint. We track only
        // the provider id in _inFlight (not the job), so emit a stable hint.
        this._listener?.onParked(newJob, `${provider}:inflight`);
      }
      return { kind: 'parked', job: this._parked.get(provider)!.job };
    }

    // 3) New pending slot — arm the trailing debounce timer.
    const abort = new AbortController();
    const job: ScanJob = {
      provider,
      reason,
      uris,
      priority,
      timestamp: now,
      signal: abort.signal,
      jobId: generateJobId(),
    };
    const timer = setTimeout(() => this.flushPending(provider), this._debounceMs);
    // Safety net: even under a continuous burst that keeps merging, force the
    // slot to flush at createdAt + maxWaitMs. Because the debounce timer is
    // trailing (not reset on merge), maxWait mainly guards against a path that
    // keeps a slot alive without re‑submitting — but it's cheap insurance and
    // makes the latency bound explicit and testable.
    const maxWaitTimer = setTimeout(
      () => this.flushPending(provider),
      this._maxWaitMs,
    );
    this._pending.set(provider, {
      job,
      request,
      abort,
      timer,
      maxWaitTimer,
      createdAt: now,
    });
    this._listener?.onSubmitted(job, provider);
    return { kind: 'submitted', job };
  }

  /** Move a provider's pending slot to the ready heap (debounce fired). */
  private flushPending(provider: string): void {
    const slot = this._pending.get(provider);
    if (!slot) return;
    this._pending.delete(provider);
    clearTimeout(slot.maxWaitTimer);
    if (slot.abort.signal.aborted) {
      this._listener?.onCancelled(slot.job, 'aborted before flush');
      return;
    }
    const entry: ReadyEntry = { job: slot.job, request: slot.request, abort: slot.abort };
    this.heapPush(entry);
    this._listener?.onReady(slot.job, this._heap.length);
    this._flush(entry);
  }

  /**
   * Mark a provider's job as in‑flight (called by the Dispatcher when it
   * begins executing a flushed job). Arms the "next" semantics: any parked
   * slot for this provider will be released on `completeInFlight`.
   */
  beginInFlight(provider: string): void {
    this._inFlight.add(provider);
  }

  /**
   * Mark a provider's in‑flight job complete. If a parked "next" slot exists,
   * it is promoted to pending and flushed immediately (no debounce — it
   * already waited behind the in‑flight job). Returns the promoted job so the
   * dispatcher can chain it.
   */
  completeInFlight(provider: string): ReadyEntry | undefined {
    this._inFlight.delete(provider);
    const parked = this._parked.get(provider);
    if (!parked) return undefined;
    this._parked.delete(provider);
    const entry: ReadyEntry = { job: parked.job, request: parked.request, abort: parked.abort };
    // Promote straight to ready (it already waited through the in‑flight job).
    this.heapPush(entry);
    this._listener?.onReady(parked.job, this._heap.length);
    this._flush(entry);
    return entry;
  }

  /** Remove and return the highest‑priority ready job, or undefined if empty. */
  popReady(): ReadyEntry | undefined {
    return this.heapPop();
  }

  /** Peek without removing (for monitoring/tests). */
  peekReady(): ReadyEntry | undefined {
    return this._heap.length > 0 ? this._heap[0] : undefined;
  }

  /**
   * Cancel everything for the given providers: pending, parked, and ready
   * (heap entries). In‑flight jobs are aborted via their AbortController by
   * the dispatcher; here we only clear queue residency. Used by
   * `cancelProviderJobs` and dispose.
   */
  cancelProviders(providers: readonly string[], reason: string): ScanJob[] {
    const set = new Set(providers);
    const cancelled: ScanJob[] = [];

    for (const [provider, slot] of this._pending) {
      if (set.has(provider)) {
        clearTimeout(slot.timer);
        clearTimeout(slot.maxWaitTimer);
        slot.abort.abort();
        this._pending.delete(provider);
        cancelled.push(slot.job);
        this._listener?.onCancelled(slot.job, reason);
      }
    }
    for (const [provider, parked] of this._parked) {
      if (set.has(provider)) {
        parked.abort.abort();
        this._parked.delete(provider);
        cancelled.push(parked.job);
        this._listener?.onCancelled(parked.job, reason);
      }
    }
    // Heap: filter in place.
    if (this._heap.length > 0) {
      const kept: ReadyEntry[] = [];
      for (const entry of this._heap) {
        if (set.has(entry.job.provider)) {
          entry.abort.abort();
          cancelled.push(entry.job);
          this._listener?.onCancelled(entry.job, reason);
        } else {
          kept.push(entry);
        }
      }
      this._heap = kept;
    }
    return cancelled;
  }

  /** Current sizes for monitoring. */
  getSizes(): JobQueueSizes {
    return {
      pending: this._pending.size,
      ready: this._heap.length,
      inflight: this._inFlight.size,
    };
  }

  /** True if the queue has nothing pending, ready, parked, or in‑flight. */
  isIdle(): boolean {
    return (
      this._pending.size === 0 &&
      this._parked.size === 0 &&
      this._heap.length === 0 &&
      this._inFlight.size === 0
    );
  }

  /** Dispose: cancel everything and clear timers. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const slot of this._pending.values()) {
      clearTimeout(slot.timer);
      clearTimeout(slot.maxWaitTimer);
      slot.abort.abort();
    }
    for (const parked of this._parked.values()) {
      parked.abort.abort();
    }
    for (const entry of this._heap) {
      entry.abort.abort();
    }
    this._pending.clear();
    this._parked.clear();
    this._heap = [];
    this._inFlight.clear();
  }

  // ─── helpers ───────────────────────────────────────────────────────

  /** Union two URI arrays by fsPath, preserving insertion order. */
  private unionUris(a: readonly Uri[], b: readonly Uri[]): readonly Uri[] {
    if (b.length === 0) return a;
    if (a.length === 0) return b;
    const map = new Map<string, Uri>();
    for (const u of a) map.set(u.fsPath, u);
    for (const u of b) map.set(u.fsPath, u);
    return Array.from(map.values());
  }

  /** Merge two reasons, preferring the more specific (non‑generic) one. */
  private mergeReason(a: string, b: string): string {
    if (a === b) return a;
    if (a === 'file save' && b !== 'file save') return b;
    if (b === 'file save' && a !== 'file save') return a;
    return `${a};${b}`;
  }

  /**
   * Map a (source, event) pair to its priority tier (R3).
   *
   * Brief's priority ladder, highest to lowest:
   *   manual (100) > config-change (90) > startup (80) >
   *   save (50) > create (40) > rename (35) > delete (30) >
   *   realtime (20) > reconcile (10)
   *
   * `event` disambiguates the `autoscan` bucket (which currently maps all of
   * save/create/rename/delete at the same default térm). When `event` is set
   * and `source` is `autoscan`, the ladder replaces the default `autoscan`
   * tier of 50 with the event-specific value. When `event` is `undefined`
   * or `'other'`, the source tier alone governs (backwards‑compatible).
   */
  private sourceToTier(request: ScanJobRequest): number {
    const { source, event } = request;
    // Sources that fully determine tier regardless of event.
    switch (source) {
      case 'manual': return ScanPriority.Manual;
      case 'config-change': return ScanPriority.ConfigChange;
      case 'startup': return ScanPriority.Startup;
      case 'reconcile': return ScanPriority.Reconcile;
      case 'realtime': return ScanPriority.Realtime;
      case 'autoscan': {
        if (event && event !== 'other') {
          return eventTierForAutoscan(event);
        }
        return ScanPriority.Save; // legacy: autoscan without event = save tier
      }
    }
    return ScanPriority.Save;
  }

  // ─── binary heap (priority desc, then timestamp asc) ───────────────

  private heapPush(entry: ReadyEntry): void {
    this._heap.push(entry);
    this.siftUp(this._heap.length - 1);
  }

  private heapPop(): ReadyEntry | undefined {
    if (this._heap.length === 0) return undefined;
    const top = this._heap[0];
    const last = this._heap.pop()!;
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Higher priority first; ties broken by earlier timestamp (FIFO). */
  private ranksBefore(a: ReadyEntry, b: ReadyEntry): boolean {
    if (a.job.priority !== b.job.priority) return a.job.priority > b.job.priority;
    return a.job.timestamp < b.job.timestamp;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.ranksBefore(this._heap[i], this._heap[parent])) {
        [this._heap[i], this._heap[parent]] = [this._heap[parent], this._heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(i: number): void {
    const n = this._heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this.ranksBefore(this._heap[l], this._heap[best])) best = l;
      if (r < n && this.ranksBefore(this._heap[r], this._heap[best])) best = r;
      if (best === i) break;
      [this._heap[i], this._heap[best]] = [this._heap[best], this._heap[i]];
      i = best;
    }
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('JobQueue is disposed');
    }
  }
}

/**
 * (R3) Map a fine-grained file event to a {@link ScanPriority} tier for the
 * autoscan source. The complete ladder lives in the design brief:
 *   save (50) > create (40) > rename (35) > delete (30).
 */
function eventTierForAutoscan(event: ScanEventKind): number {
  switch (event) {
    case 'save': return ScanPriority.Save;
    case 'create': return ScanPriority.Create;
    case 'rename': return ScanPriority.Rename;
    case 'delete': return ScanPriority.Delete;
    case 'reconcile': return ScanPriority.Reconcile;
    default: return ScanPriority.Save;
  }
}
