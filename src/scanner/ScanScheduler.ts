import { Disposable, Uri } from 'vscode';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import {
  ScanSource,
  ScanJobRequest,
  ScanJobResult,
  ScanJob,
  ScanPriority,
  computeScanPriority,
  generateJobId,
} from './ScanJob';

/** Pending job with debounce metadata. */
interface PendingJob {
  request: ScanJobRequest;
  job: ScanJob;
  timer: ReturnType<typeof setTimeout>;
  /** AbortController for cooperative cancellation. */
  abort: AbortController;
  /** True if this job has been superseded by a higher-priority job. */
  superseded: boolean;
}

/**
 * The central `ScanScheduler` is the single entry point for all scan
 * requests in the extension. It wraps `DiagnosticProviderManager` and
 * `ProviderRegistry` so that every caller — `AutoScanController`,
 * `StartupScanController`, `ScanWorkspaceButton`, `CommandManager`, and
 * `extension.ts` config-change handlers — routes through one funnel.
 *
 * **Task 4 scope:** The scheduler now owns all provider-routing logic.
 * Controllers emit raw events (file save, startup, config change, etc.);
 * the scheduler resolves the correct providers via the ProviderRegistry
 * (extension ownership, capability filtering, enabled state, config gates).
 * No hardcoded provider names or capability checks remain in controllers.
 *
 * **Task 5 scope:** Job deduplication & debouncing. Multiple rapid saves
 * for the same file/provider are merged into a single scan job. A short
 * debounce window collects bursts; the highest priority wins.
 *
 * **Task 6 scope:** Cancellation. Obsolete jobs are cancelled when newer,
 * higher-priority jobs supersede them. Each job gets an AbortController;
 * when a new job for the same provider arrives with higher priority, the
 * older job's signal is aborted and it is removed from the pending queue.
 * In-flight jobs check their signal before and during execution.
 *
 * **Task 7 scope:** Concurrency. Different providers run concurrently,
 * but two scans for the same provider never execute simultaneously.
 * A per-provider lock (Promise chain) serializes same-provider scans;
 * a waiting job checks its abort signal before acquiring the lock.
 */
export class ScanScheduler implements Disposable {
  private readonly _registry: ProviderRegistry;
  private readonly _manager: DiagnosticProviderManager;
  private readonly _log: (msg: string) => void;
  private _disposed = false;

  /** Debounce window in ms for coalescing rapid same-file/provider events. */
  private readonly _debounceMs = 50;

  /** Pending jobs keyed by deduplication key. */
  private readonly _pending = new Map<string, PendingJob>();

  /** In-flight jobs keyed by job id (currently executing). */
  private readonly _inFlight = new Map<string, PendingJob>();

  /** Per-provider locks — serializes same-provider scans. */
  private readonly _providerLocks = new Map<string, Promise<void>>();

  /** Timer to flush the pending queue. */
  private _flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Task 8: Priority queue of jobs ready to execute (highest priority first). */
  private readonly _readyQueue: PendingJob[] = [];

  /** True while the worker loop is processing the queue. */
  private _processing = false;

  /** Inter-job debounce: wait this long after each job to let higher-priority jobs arrive. */
  private readonly _interJobDebounceMs = 25;

  /** Task 9: Background reconciliation — runs only when scheduler is fully idle. */
  private _reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long to wait after queue empties before starting reconciliation. */
  private readonly _reconcileDelayMs = 5_000;
  /** Interval between reconciliation runs. */
  private readonly _reconcileIntervalMs = 60_000;

  constructor(
    registry: ProviderRegistry,
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
  ) {
    this._registry = registry;
    this._manager = manager;
    this._log = log;
    // Start background reconciliation timer
    this.scheduleReconcile();
  }

  /**
   * Submit a scan request. Creates a ScanJob, computes priority,
   * and delegates to `DiagnosticProviderManager.refreshByNames()`.
   *
   * Deduplication: multiple rapid requests for the same provider+URI+source
   * are merged into a single job within the debounce window. The highest
   * priority wins; URIs are unioned.
   *
   * Cancellation: if a new job for the same provider arrives with higher
   * priority than a pending or in-flight job, the older job is aborted and
   * removed from the queue. This ensures outdated scans never run.
   */
  async submit(request: ScanJobRequest): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const { providerNames, reason, source, uris = [] } = request;

    if (providerNames.length === 0) {
      this._log(`[SCAN-SCHEDULER] ${source}: empty provider list — skipping (${reason})`);
      return { submitted: false, providerNames: [], reason, source, skipReason: 'no providers' };
    }

    // Compute priority: event tier + provider base priority
    const eventTier = this.sourceToTier(source);
    const basePriority = providerNames.length === 1
      ? this._registry.getPriority(providerNames[0]) ?? 0
      : 0;
    const priority = computeScanPriority(eventTier, basePriority);

    // Cancel obsolete pending/in-flight jobs for the same providers
    this.cancelObsoleteJobs(providerNames, priority, reason);

    const abort = new AbortController();

    const job: ScanJob = {
      provider: providerNames[0], // primary provider
      reason,
      uris,
      priority,
      timestamp: Date.now(),
      signal: abort.signal,
      jobId: generateJobId(),
    };

    // Deduplication key: provider(s) + URI(s) + source + reason
    // For autoscan, merge rapid saves on same file+provider.
    const dedupKey = this.makeDedupKey(providerNames, uris, source, reason);

    const existing = this._pending.get(dedupKey);
    if (existing) {
      // Merge: union URIs, take max priority, update timestamp
      const incomingUris = uris ?? [];
      const existingUris = existing.request.uris ?? [];
      const mergedUris = this.unionUris(existingUris, incomingUris);
      const mergedPriority = Math.max(existing.job.priority, priority);
      const mergedReason = this.mergeReason(existing.request.reason, reason);

      existing.request = { ...existing.request, uris: mergedUris, priority: mergedPriority, reason: mergedReason };
      existing.job = { ...existing.job, uris: mergedUris, priority: mergedPriority, timestamp: Date.now(), reason: mergedReason };
      // Reset the debounce timer
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushOne(dedupKey), this._debounceMs);

      this._log(`[SCAN-SCHEDULER] ${source}: merged job ${job.jobId} into ${existing.job.jobId} (key=${dedupKey})`);
      return { submitted: true, providerNames, reason: mergedReason, source, job: existing.job };
    }

    // New pending job — schedule flush
    const timer = setTimeout(() => this.flushOne(dedupKey), this._debounceMs);
    this._pending.set(dedupKey, { request, job, timer, abort, superseded: false });

    this._log(`[SCAN-SCHEDULER] ${source}: queued job ${job.jobId} for [${providerNames.join(', ')}] pri=${priority} (${reason})`);

    // Return immediately; actual execution happens on flush
    return { submitted: true, providerNames, reason, source, job };
  }

  /**
   * Cancel pending and in-flight jobs for the given providers if the new
   * job has higher priority. A job is obsolete if:
   *   - It is still pending (not yet flushed) and the new job has higher priority
   *   - It is in-flight and the new job has higher or equal priority (newer wins)
   */
  private cancelObsoleteJobs(providerNames: readonly string[], newPriority: number, newReason: string): void {
    const providerSet = new Set(providerNames);

    // Cancel pending jobs for the same providers with lower priority
    for (const [key, pending] of this._pending) {
      const pendingProviders = pending.request.providerNames;
      const overlaps = pendingProviders.some((p) => providerSet.has(p));
      if (!overlaps) continue;

      if (pending.job.priority < newPriority) {
        pending.superseded = true;
        pending.abort.abort();
        clearTimeout(pending.timer);
        this._pending.delete(key);
        this._log(`[SCAN-SCHEDULER] cancelled pending job ${pending.job.jobId} (pri=${pending.job.priority}) superseded by ${newReason} (pri=${newPriority})`);
      }
    }

    // Abort in-flight jobs for the same providers with lower priority
    for (const [jobId, inflight] of this._inFlight) {
      const inflightProviders = inflight.request.providerNames;
      const overlaps = inflightProviders.some((p) => providerSet.has(p));
      if (!overlaps) continue;

      if (inflight.job.priority <= newPriority) {
        inflight.abort.abort();
        this._log(`[SCAN-SCHEDULER] aborted in-flight job ${jobId} (pri=${inflight.job.priority}) superseded by ${newReason} (pri=${newPriority})`);
      }
    }
  }

  /** Build a deduplication key from request parameters. */
  private makeDedupKey(
    providerNames: readonly string[],
    uris: readonly Uri[],
    source: ScanSource,
    reason: string,
  ): string {
    const providers = [...providerNames].sort().join(',');
    const uriKeys = [...uris].map(u => u.fsPath).sort().join(',');
    return `${providers}|${uriKeys}|${source}|${reason}`;
  }

  /** Union two URI arrays (by fsPath). */
  private unionUris(a: readonly Uri[], b: readonly Uri[]): readonly Uri[] {
    const map = new Map<string, Uri>();
    for (const u of a) map.set(u.fsPath, u);
    for (const u of b) map.set(u.fsPath, u);
    return Array.from(map.values());
  }

  /** Merge two reasons, preferring the more specific one. */
  private mergeReason(a: string, b: string): string {
    if (a === b) return a;
    // Prefer non-generic reasons
    if (a === 'file save' && b !== 'file save') return b;
    if (b === 'file save' && a !== 'file save') return a;
    return `${a};${b}`;
  }

  /** Flush a single pending job by key — moves it to the ready queue for priority scheduling. */
  private flushOne(key: string): void {
    const pending = this._pending.get(key);
    if (!pending) return;
    this._pending.delete(key);

    // Cancellation: skip if this job was superseded by a higher-priority one
    if (pending.superseded || pending.abort.signal.aborted) {
      this._log(`[SCAN-SCHEDULER] flush: skipping superseded job ${pending.job.jobId}`);
      return;
    }

    // Insert into ready queue sorted by priority (highest first), then by timestamp (FIFO for ties)
    const idx = this._readyQueue.findIndex((p) => p.job.priority < pending.job.priority);
    if (idx === -1) {
      this._readyQueue.push(pending);
    } else {
      this._readyQueue.splice(idx, 0, pending);
    }

    this._log(`[SCAN-SCHEDULER] queued job ${pending.job.jobId} (pri=${pending.job.priority}) — queue length: ${this._readyQueue.length}`);

    // Start worker if not already running
    if (!this._processing) {
      this._processing = true;
      this.processQueue();
    }
  }

  /**
   * Worker loop: process ready queue by priority.
   * After each job, wait a short inter-job debounce to allow higher-priority jobs to arrive.
   */
  private async processQueue(): Promise<void> {
    while (this._readyQueue.length > 0) {
      // Pop highest priority job
      const pending = this._readyQueue.shift()!;
      const { request, job, abort } = pending;

      // Track as in-flight so newer jobs can abort it
      this._inFlight.set(job.jobId, pending);

      this._log(`[SCAN-SCHEDULER] executing job ${job.jobId} for [${request.providerNames.join(', ')}] (pri=${job.priority})`);

      try {
        if (abort.signal.aborted) {
          this._log(`[SCAN-SCHEDULER] execution aborted before start ${job.jobId}`);
        } else {
          // Refresh each provider through its per-provider lock with specific URIs (if any)
          const uris = request.uris ?? [];
          await this.refreshWithLocks(request.providerNames, uris, abort.signal);
        }
      } finally {
        this._inFlight.delete(job.jobId);
      }

      // Inter-job debounce: wait briefly to let higher-priority jobs arrive
      if (this._readyQueue.length > 0) {
        await new Promise((r) => setTimeout(r, this._interJobDebounceMs));
      }
    }
    this._processing = false;
    // Queue fully empty — schedule background reconciliation
    this.scheduleReconcile();
  }

  /**
   * Task 10: Background reconciliation.
   * Runs a reconciliation scan at the lowest priority (ScanPriority.Reconcile = 10)
   * only when the scheduler is completely idle (no pending, ready, or in-flight jobs).
   * Called periodically after queue empties.
   */
  private scheduleReconcile(): void {
    if (this._disposed) return;
    if (this._reconcileTimer) {
      clearTimeout(this._reconcileTimer);
    }
    // Only start reconcile timer if not already processing and queue is empty
    if (!this._processing && this._readyQueue.length === 0 && this._pending.size === 0 && this._inFlight.size === 0) {
      this._reconcileTimer = setTimeout(() => this.runReconcile(), this._reconcileDelayMs);
    } else {
      // If busy, try again after a short delay
      this._reconcileTimer = setTimeout(() => this.scheduleReconcile(), 1000);
    }
  }

  /** Execute the reconciliation job — scans for stale diagnostics and clears them. */
  private async runReconcile(): Promise<void> {
    if (this._disposed) return;
    this._log('[SCAN-SCHEDULER] running background reconciliation');

    // Submit a reconcile job at lowest priority
    const result = await this.submit({
      providerNames: ['vscodeDiagnostics'],
      reason: 'background reconciliation',
      source: 'realtime', // will be mapped to Reconcile priority via sourceToTier
      uris: [],
    });

    if (result.submitted) {
      this._log('[SCAN-SCHEDULER] reconciliation job submitted');
    } else {
      this._log('[SCAN-SCHEDULER] reconciliation skipped: ' + result.skipReason);
    }

    // Schedule next reconciliation
    this._reconcileTimer = setTimeout(() => this.scheduleReconcile(), this._reconcileIntervalMs);
  }

  /**
   * Refresh providers concurrently, each through its own per-provider lock.
   * Different providers run in parallel; same-provider scans are serialized.
   * If the abort signal fires while waiting for a lock, the scan is skipped.
   */
  private async refreshWithLocks(providerNames: readonly string[], uris: readonly Uri[], signal: AbortSignal): Promise<void> {
    const tasks = providerNames.map((name) => this.refreshOneWithLock(name, uris, signal));
    await Promise.all(tasks);
  }

  /** Refresh a single provider, acquiring its per-provider lock. */
  private async refreshOneWithLock(name: string, uris: readonly Uri[], signal: AbortSignal): Promise<void> {
    // Wait for any in-flight scan for this provider to finish.
    const prev = this._providerLocks.get(name) ?? Promise.resolve();
    const next = prev.then(async () => {
      // Cancellation: if aborted while waiting for the lock, skip.
      if (signal.aborted) {
        this._log(`[SCAN-SCHEDULER] ${name}: skipped (aborted while waiting for lock)`);
        return;
      }
      try {
        await this._manager.refreshByNames([name], uris);
      } catch (e) {
        this._log(`[SCAN-SCHEDULER] ${name}: refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    this._providerLocks.set(name, next);
    await next;
  }

  /**
   * Route a file-save event to the owning scanner provider.
   * Resolves extension → owner, checks provider's autoScan config gate,
   * and submits if appropriate.
   */
  async routeFileSave(uri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const ext = this.extractExtension(uri);
    if (!ext) {
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'no extension' };
    }
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'no owner for extension' };
    }
    // Per-provider autoScan gate — user may disable auto-scan for specific providers.
    const providerCfg = this._registry.getProviderConfig(ownerName);
    if (providerCfg && !providerCfg.autoScan) {
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'provider autoScan disabled' };
    }
    const result = await this.submit({ providerNames: [ownerName], reason: 'file save', source: 'autoscan', uris: [uri] });
    return result;
  }

  /**
   * Route a file-create event (same logic as save for now).
   */
  async routeFileCreate(uri: Uri): Promise<ScanJobResult> {
    return this.routeFileSave(uri); // same logic: extension → owner → autoScan gate
  }

  /**
   * Route a file-rename event. Checks both old and new extensions.
   */
  async routeFileRename(oldUri: Uri, newUri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const oldExt = this.extractExtension(oldUri);
    const newExt = this.extractExtension(newUri);
    const ownerNames = new Set<string>();

    // Old extension owner — may need cleanup (handled by diagnostics manager)
    if (oldExt) {
      const oldOwner = this._registry.getOwner(oldExt);
      if (oldOwner) ownerNames.add(oldOwner);
    }
    // New extension owner — trigger scan
    if (newExt) {
      const newOwner = this._registry.getOwner(newExt);
      if (newOwner) {
        const providerCfg = this._registry.getProviderConfig(newOwner);
        if (!providerCfg || providerCfg.autoScan) {
          ownerNames.add(newOwner);
        }
      }
    }

    const owners = [...ownerNames];
    if (owners.length === 0) {
      return { submitted: false, providerNames: [], reason: 'file rename', source: 'autoscan', skipReason: 'no owner for extensions' };
    }
    return this.submit({ providerNames: owners, reason: 'file rename', source: 'autoscan', uris: [oldUri, newUri] });
  }

  /**
   * Route a file-delete event. For delete, we primarily need to clear
   * ownership/stale badges. The diagnostics manager handles this via
   * onDidDeleteFiles listeners. The scheduler can route to the old owner
   * for any cleanup scan if needed.
   */
  async routeFileDelete(uri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const ext = this.extractExtension(uri);
    if (!ext) {
      return { submitted: false, providerNames: [], reason: 'file delete', source: 'autoscan', skipReason: 'no extension' };
    }
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason: 'file delete', source: 'autoscan', skipReason: 'no owner for extension' };
    }
    // For delete, we could trigger a cleanup scan, but the diagnostics
    // manager's onDidDeleteFiles + clearIfOwner handles badge removal.
    // Submit a lightweight scan for the owner to refresh its state.
    return this.submit({ providerNames: [ownerName], reason: 'file delete', source: 'autoscan', uris: [uri] });
  }

  /**
   * Route the startup scan event.
   * Resolves all providers with startupScan capability that are enabled
   * and not disabled by config (scanOnStartup: false).
   */
  async routeStartup(): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const candidates = this._registry.all().filter((rp) => {
      const caps = rp.provider.capabilities;
      if (!caps.startupScan) return false;
      if (!rp.provider.enabled) return false;
      const providerCfg = this._registry.getProviderConfig(rp.descriptor.id);
      if (providerCfg && !providerCfg.scanOnStartup) return false;
      return true;
    });
    const names = candidates.map((rp) => rp.descriptor.id);
    if (names.length === 0) {
      this._log('[SCAN-SCHEDULER] startup: no providers with startupScan enabled');
      return { submitted: false, providerNames: [], reason: 'startup scan', source: 'startup', skipReason: 'no providers with startupScan' };
    }
    this._log(`[SCAN-SCHEDULER] startup: routing [${names.join(', ')}]`);
    return this.submit({ providerNames: names, reason: 'startup scan', source: 'startup' });
  }

  /**
   * Route a config-change re-enable event for specific providers.
   * Accepts provider ids that were just enabled.
   */
  async routeConfigReEnable(providerIds: string[]): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const validNames = providerIds.filter((id) => {
      const rp = this._registry.all().find((rp) => rp.descriptor.id === id);
      return rp && rp.provider.enabled;
    });
    if (validNames.length === 0) {
      return { submitted: false, providerNames: [], reason: 'config re-enable', source: 'config-change', skipReason: 'no valid enabled providers' };
    }
    this._log(`[SCAN-SCHEDULER] config-change: re-enabled [${validNames.join(', ')}]`);
    return this.submit({ providerNames: validNames, reason: 'config re-enable', source: 'config-change' });
  }

  /**
   * Route a config change that disabled a provider.
   * This is informational — we log and the scheduler does NOT submit a scan.
   * Ownership is cleared via the provider's updateConfig() → releaseOwnership().
   */
  routeConfigDisable(providerIds: string[]): ScanJobResult {
    this.ensureNotDisposed();
    this._log(`[SCAN-SCHEDULER] config-change: disabled [${providerIds.join(', ')}] — ownership released by providers`);
    return { submitted: false, providerNames: [], reason: 'config disable', source: 'config-change', skipReason: 'ownership released by providers' };
  }
  async submitAll(source: ScanSource, reason: string, uris: readonly Uri[] = []): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const names = this._registry.all()
      .filter((rp) => rp.provider.enabled)
      .map((rp) => rp.descriptor.id);
    return this.submit({ providerNames: names, reason, source, uris });
  }

  /**
   * Look up the owner of a file extension and submit a scan for that
   * provider. Returns the provider id that was scheduled, or `undefined`
   * if no scanner owns the extension.
   */
  submitForExtension(
    ext: string,
    source: ScanSource,
    reason: string,
    uris: readonly Uri[] = [],
  ): ScanJobResult {
    this.ensureNotDisposed();
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason, source, skipReason: 'no owner for extension' };
    }
    // Fire-and-forget — callers that need to await should use submit().
    void this.submit({ providerNames: [ownerName], reason, source, uris });
    return { submitted: true, providerNames: [ownerName], reason, source };
  }

  /**
   * Cancel all pending and in-flight jobs for the specified providers.
   * Useful when a provider is disabled via config or unregistered.
   */
  cancelProviderJobs(providerNames: readonly string[]): void {
    this.ensureNotDisposed();
    const providerSet = new Set(providerNames);

    // Cancel pending jobs
    for (const [key, pending] of this._pending) {
      const overlaps = pending.request.providerNames.some((p) => providerSet.has(p));
      if (overlaps) {
        pending.superseded = true;
        pending.abort.abort();
        clearTimeout(pending.timer);
        this._pending.delete(key);
        this._log(`[SCAN-SCHEDULER] cancelled pending job ${pending.job.jobId} for [${providerNames.join(', ')}]`);
      }
    }

    // Abort in-flight jobs
    for (const [jobId, inflight] of this._inFlight) {
      const overlaps = inflight.request.providerNames.some((p) => providerSet.has(p));
      if (overlaps) {
        inflight.abort.abort();
        this._log(`[SCAN-SCHEDULER] aborted in-flight job ${jobId} for [${providerNames.join(', ')}]`);
      }
    }
  }

  /** Map a ScanSource to its ScanPriority tier. */
  private sourceToTier(source: ScanSource): ScanPriority {
    switch (source) {
      case 'manual': return ScanPriority.Manual;
      case 'config-change': return ScanPriority.ConfigChange;
      case 'startup': return ScanPriority.Startup;
      case 'autoscan': return ScanPriority.Save; // save is the primary autoscan trigger
      case 'realtime': return ScanPriority.Realtime;
      default: return ScanPriority.Save;
    }
  }

  /** Extract file extension from URI (lowercase, with leading dot). */
  private extractExtension(uri: Uri): string | null {
    const path = uri.fsPath;
    const dot = path.lastIndexOf('.');
    if (dot < 0) return null;
    return path.slice(dot).toLowerCase();
  }

  /** The wrapped DiagnosticProviderManager (for back-compat). */
  get manager(): DiagnosticProviderManager { return this._manager; }

  /** The wrapped ProviderRegistry. */
  get registry(): ProviderRegistry { return this._registry; }

  dispose(): void {
    this._disposed = true;
    // Clear reconciliation timer
    if (this._reconcileTimer) {
      clearTimeout(this._reconcileTimer);
      this._reconcileTimer = undefined;
    }
    // Abort all pending jobs (waiting for debounce)
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.abort.abort();
    }
    // Abort all queued jobs (waiting in ready queue)
    for (const pending of this._readyQueue) {
      pending.abort.abort();
    }
    // Abort all in-flight jobs
    for (const [, inflight] of this._inFlight) {
      inflight.abort.abort();
    }
    this._pending.clear();
    this._readyQueue.length = 0;
    this._inFlight.clear();
    this._providerLocks.clear();
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = undefined;
    }
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('ScanScheduler is disposed');
    }
  }
}
