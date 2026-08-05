import { Disposable, Uri } from 'vscode';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import {
  ScanSource,
  ScanJobRequest,
  ScanJobResult,
  ScanJob,
  ScanDecision,
} from './ScanJob';
import { Dispatcher } from './Dispatcher';
import {
  JobQueue,
  JobQueueListener,
  ReadyEntry,
  FlushHandler,
} from './JobQueue';

/** Telemetry monitor for scheduler metrics */
interface ScanSchedulerMonitor {
  onJobSubmitted(job: ScanJob, dedupKey: string): void;
  onJobMerged(existingJobId: string, newJobId: string, dedupKey: string): void;
  onJobFlushed(job: ScanJob, queueLength: number): void;
  onJobStarted(job: ScanJob): void;
  onJobCompleted(job: ScanJob, executionTimeMs: number): void;
  onJobCancelled(job: ScanJob, reason: string): void;
  onJobFailed(job: ScanJob, error: Error): void;
  onReconcileRun(): void;
  getQueueSizes(): { pending: number; ready: number; inflight: number };
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
 * **Task 5 scope (T3 redesign):** Job deduplication & debouncing. Multiple
 * rapid saves for the same file/provider are merged into a single scan job.
 * The coalesce key is the **provider id**, so 10 saves for the same TSC
 * provider → 1 merged scan, not 10. A trailing debounce window collects
 * bursts; the highest priority wins. The `JobQueue` handles this entirely.
 *
 * **Task 6 scope:** Cancellation. Obsolete jobs are cancelled when newer,
 * higher-priority jobs supersede them. Each job gets an AbortController;
 * when a new job for the same provider arrives with higher priority, the
 * older job's signal is aborted and it is removed from the pending queue.
 * In-flight jobs check their signal before and during execution.
 *
 * **Task 7 scope:** Concurrency. Different providers run concurrently,
 * but two scans for the same provider never execute simultaneously.
 * The Dispatcher's per-provider lock (Promise chain) serializes same-
 * provider scans; a waiting job checks its abort signal before acquiring.
 *
 * **T2 scope:** Execution is delegated to the `Dispatcher`, which owns
 * the per-provider serialization lock and provider invocation. The scheduler
 * retains scheduling decisions (when/whether) and hands off execution.
 *
 * **T3 scope:** Queue management is delegated to the `JobQueue`, which
 * handles provider-keyed coalescing, trailing debounce, binary-heap priority
 * ordering, depth-1 parked slots, and cancellation. The scheduler bridges
 * the JobQueue → Dispatcher pipeline and maintains the monitor interface.
 *
 * **Task 11 scope:** Performance metrics. Integrates with ScanSchedulerMonitor
 * to track queue lengths, job latency, merge/cancel counts, provider execution
 * time, and end-to-end save-to-decoration latency.
 */
export class ScanScheduler implements Disposable {
   private readonly _registry: ProviderRegistry;
   private readonly _manager: DiagnosticProviderManager;
   private readonly _log: (msg: string) => void;
   private _monitor?: ScanSchedulerMonitor;
   private _disposed = false;
   /** Count of mutation-based submissions since last reconciliation (R5). */
   private _mutationsSinceReconcile = 0;

  /**
   * The coalescing queue (T3). Handles provider-keyed merge, trailing
   * debounce, binary-heap priority ordering, parked slots, and
   * cancellation. Owns all scheduling state — the scheduler is the bridge.
   */
  private readonly _queue: JobQueue;

  /**
   * Per-provider execution dispatcher (T2). Owns the per-provider
   * serialization lock + provider invocation.
   */
  private readonly _dispatcher: Dispatcher;

  /** True while the worker loop is processing the ready heap. */
  private _processing = false;

  /** Inter-job debounce: wait this long after each job to let higher-priority jobs arrive. */
  private readonly _interJobDebounceMs = 25;

  /** Task 9: Background reconciliation — runs only when scheduler is fully idle. */
  private _reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long to wait after queue empties before starting reconciliation. */
  private readonly _reconcileDelayMs = 5_000;
  /** Interval between reconciliation runs. */
  private readonly _reconcileIntervalMs = 60_000;

  /**
   * Construct the scheduler.
   *
   * @param options (R1) overrides the JobQueue debounce/maxWait. When omitted,
   *   the scheduler derives them from the user‑facing `problemExplorer.autoScanDelay`
   *   config via {@link setDebounceMs}. Effective defaults when no config is
   *   supplied: `debounceMs=50, maxWaitMs=1000` (legacy). With config, the
   *   `autoScanDelay` knob is honored and `maxWaitMs = max(autoScanDelay * 4, 1000)`.
   */
  constructor(
    registry: ProviderRegistry,
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
    monitor?: ScanSchedulerMonitor,
    options?: { debounceMs?: number; maxWaitMs?: number },
  ) {
    this._registry = registry;
    this._manager = manager;
    this._log = log;
    this._monitor = monitor;

    const debounceMs = options?.debounceMs ?? 50;
    const maxWaitMs = options?.maxWaitMs ?? Math.max(debounceMs * 4, 1000);

    // Wire the JobQueue listener to bridge queue events → scheduler monitor.
    const queueListener: JobQueueListener | undefined = monitor
      ? {
          onSubmitted: (job, key) => monitor.onJobSubmitted(job, key),
          onMerged: (existingId, incomingId, key) => monitor.onJobMerged(existingId, incomingId, key),
          onReady: (job, heapSize) => monitor.onJobFlushed(job, heapSize),
          onParked: () => {},   // parked is an internal queue state — no monitor surface yet
          onCancelled: (job, reason) => monitor.onJobCancelled(job, reason),
        }
      : undefined;

    // The flush handler is called by JobQueue whenever a job clears debounce.
    // It starts the worker loop if not already running.
    const onFlush: FlushHandler = (_entry: ReadyEntry) => {
      if (!this._processing) {
        this._processing = true;
        this.processQueue();
      }
    };

    this._queue = new JobQueue(onFlush, queueListener, { debounceMs, maxWaitMs });

    // The dispatcher delegates to DPM.refreshByNames through the per-provider
    // lock. log + monitor wiring preserve the legacy telemetry surface.
    this._dispatcher = new Dispatcher(
      (names, uris) => this._manager.refreshByNames([...names], uris),
      log,
      monitor
        ? {
            onProviderStart: () => {},
            onProviderFinish: () => {},
          }
        : undefined,
    );
    // Start background reconciliation timer
    this.scheduleReconcile();
  }

  /**
   * (R1) Hot‑reload the debounce window from the `problemExplorer.autoScanDelay`
   * config setting. Applies only to slots created *after* this call (already‑
   * armed pending slots keep their original timers — preserves the trailing
   * debounce invariant). `maxWaitMs` is recomputed as `max(delay * 4, 1000)`.
   *
   * Called from `extension.ts` on `configManager.onDidChangeConfig`.
   */
  setDebounceMs(debounceMs: number): void {
    this.ensureNotDisposed();
    if (!Number.isFinite(debounceMs) || debounceMs <= 0) return;
    const maxWaitMs = Math.max(debounceMs * 4, 1000);
    this._queue.setOptions({ debounceMs, maxWaitMs });
    this._log(`[SCAN-SCHEDULER] debounce -> ${debounceMs}ms (maxWait ${maxWaitMs}ms)`);
  }

  /** Attach or replace the monitor (useful when monitor is created after scheduler). */
  setMonitor(monitor: ScanSchedulerMonitor): void {
    this._monitor = monitor;
  }

  /**
   * Submit a scan request. Creates a ScanJob, computes priority,
   * and delegates to `DiagnosticProviderManager.refreshByNames()`.
   *
   * Deduplication: multiple rapid requests for the same provider
   * are merged into a single job within the debounce window (T3).
   * The coalesce key is the provider id — so 10 saves for TSC → 1 scan.
   *
   * Cancellation: handled by JobQueue's parked-slot and maxWait logic.
   */
async submit(request: ScanJobRequest): Promise<ScanJobResult> {
     this.ensureNotDisposed();
     const { providerNames, reason, source } = request;

     if (providerNames.length === 0) {
       this._log(`[SCAN-SCHEDULER] ${source}: empty provider list — skipping (${reason})`);
       return { submitted: false, providerNames: [], reason, source, skipReason: 'no providers' };
     }

     // Compute per-provider base priority from the registry.
     // For multi-provider requests, use 0 (no per-provider boost).
     const basePriority = providerNames.length === 1
       ? this._registry.getPriority(providerNames[0]) ?? 0
       : 0;

     const outcome = this._queue.submit(request, basePriority);

     // Track mutations for reconciliation gating (R5): increment for autoscan sources
     if (source === 'autoscan') {
       this._mutationsSinceReconcile++;
     }

switch (outcome.kind) {
        case 'rejected':
          this._log(`[SCAN-SCHEDULER] ${source}: rejected — ${outcome.reason}`);
          return { submitted: false, providerNames: [], reason, source, skipReason: outcome.reason };

       case 'submitted':
         this._log(`[SCAN-SCHEDULER] ${source}: queued job ${outcome.job.jobId} for [${providerNames.join(', ')}] pri=${outcome.job.priority} (${reason})`);
         return { submitted: true, providerNames, reason, source, job: outcome.job };

       case 'merged':
         this._log(`[SCAN-SCHEDULER] ${source}: merged into job ${outcome.job.jobId} for [${providerNames.join(', ')}] pri=${outcome.job.priority}`);
         return { submitted: true, providerNames, reason, source, job: outcome.job };

       case 'parked':
         this._log(`[SCAN-SCHEDULER] ${source}: parked behind in-flight job for [${providerNames.join(', ')}] pri=${outcome.job.priority}`);
         return { submitted: true, providerNames, reason, source, job: outcome.job };
     }
   }

  /**
   * Worker loop: drain the ready heap by priority, executing each job
   * through the Dispatcher. After each job, wait a short inter-job
   * debounce to allow higher-priority jobs to arrive.
   *
   * Execution is delegated to the Dispatcher (T2), which owns the
   * per-provider serialization lock. The scheduler retains in-flight
   * tracking via the JobQueue's beginInFlight/completeInFlight lifecycle.
   */
  private async processQueue(): Promise<void> {
    while (true) {
      const entry = this._queue.popReady();
      if (!entry) break;

      const { job, request, abort } = entry;
      const provider = job.provider;

      // Mark the provider in-flight in the queue (enables parked-slot logic).
      this._queue.beginInFlight(provider);

      this._log(`[SCAN-SCHEDULER] executing job ${job.jobId} for ${provider} (pri=${job.priority})`);
      this._monitor?.onJobStarted(job);

      const startTime = Date.now();
      let success = true;
      let error: Error | undefined;

      try {
        if (abort.signal.aborted) {
          this._log(`[SCAN-SCHEDULER] execution aborted before start ${job.jobId}`);
        } else {
          const result = await this._dispatcher.execute(request, abort.signal);
          success = result.success;
          error = result.error;
        }
      } catch (e) {
        success = false;
        error = e instanceof Error ? e : new Error(String(e));
        this._log(`[SCAN-SCHEDULER] job ${job.jobId} failed: ${error.message}`);
      } finally {
        const executionTimeMs = Date.now() - startTime;
        // Complete in-flight in the queue — this promotes any parked slot.
        this._queue.completeInFlight(provider);
        if (success) {
          this._monitor?.onJobCompleted(job, executionTimeMs);
        } else {
          this._monitor?.onJobFailed(job, error!);
        }
      }

      // Inter-job debounce: wait briefly to let higher-priority jobs arrive
      // (but only if the queue might have more work — skip if promoted parked
      // job is the only thing left and it was already waiting).
      if (this._queue.getSizes().ready > 0) {
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
    // Only start reconcile timer if queue is completely idle
    if (this._queue.isIdle()) {
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

     // R5: Skip reconciliation if no mutations since last run
     if (this._mutationsSinceReconcile === 0) {
       this._log('[SCAN-SCHEDULER] reconciliation skipped: no mutations since last run');
       // Still schedule next reconciliation
       this._reconcileTimer = setTimeout(() => this.scheduleReconcile(), this._reconcileIntervalMs);
       return;
     }

     // Submit a reconcile job at lowest priority
     const result = await this.submit({
       providerNames: ['vscodeDiagnostics'],
       reason: 'background reconciliation',
       source: 'reconcile',
       uris: [],
     });

     if (result.submitted) {
       this._log('[SCAN-SCHEDULER] reconciliation job submitted');
       this._monitor?.onReconcileRun();
     } else {
       this._log('[SCAN-SCHEDULER] reconciliation skipped: ' + result.skipReason);
     }

     // Reset mutation counter after reconciliation attempt
     this._mutationsSinceReconcile = 0;

     // Schedule next reconciliation
     this._reconcileTimer = setTimeout(() => this.scheduleReconcile(), this._reconcileIntervalMs);
   }

  /**
   * Route a file-save event to the owning scanner provider.
   * Resolves extension → owner, checks provider's autoScan config gate,
   * and submits if appropriate.
   *
   * Every exit point is logged with a {@link ScanDecision} so that
   * debugging "I saved and nothing happened" is a single log line.
   */
  async routeFileSave(uri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const ext = this.extractExtension(uri);
    if (!ext) {
      this.logDecision(ScanDecision.NoExtension, uri, 'file save', 'no extension');
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'no extension' };
    }
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      this.logDecision(ScanDecision.UnsupportedExtension, uri, 'file save', `no owner for ${ext}`);
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'no owner for extension' };
    }
    // Per-provider autoScan gate — user may disable auto-scan for specific providers.
    const providerCfg = this._registry.getProviderConfig(ownerName);
    if (providerCfg && !providerCfg.autoScan) {
      this.logDecision(ScanDecision.AutoScanDisabled, uri, 'file save', `${ownerName}.autoScan=false`);
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'provider autoScan disabled' };
    }
    this.logDecision(ScanDecision.Accepted, uri, 'file save', `owner=${ownerName}`);
    const result = await this.submit({ providerNames: [ownerName], reason: 'file save', source: 'autoscan', event: 'save', uris: [uri] });
    return result;
  }

  /**
   * Log a single scan-routing decision. This is the "decision trace"
   * — every silent exit in the routing pipeline emits one structured
   * log line so users can see exactly WHERE a save event was rejected:
   *
   *   [SCAN-DECISION] Accepted src/main.ts file_save owner=tsc
   *   [SCAN-DECISION] AutoScanDisabled src/foo.ts file_save tsc.autoScan=false
   */
  private logDecision(decision: ScanDecision, uri: Uri, reason: string, detail: string): void {
    const shortPath = uri.fsPath.split(/[\\/]/).slice(-2).join('/');
    this._log(`[SCAN-DECISION] ${decision} ${shortPath} ${reason} ${detail}`);
  }

  /**
   * Route a file-create event. Same ownership/autoScan-gate logic as save,
   * but (R3) tagged with `event: 'create'` so it lands at priority tier 40
   * (one notch below save's tier 50, per the design brief ladder).
   */
  async routeFileCreate(uri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const ext = this.extractExtension(uri);
    if (!ext) {
      this.logDecision(ScanDecision.NoExtension, uri, 'file create', 'no extension');
      return { submitted: false, providerNames: [], reason: 'file create', source: 'autoscan', skipReason: 'no extension' };
    }
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      this.logDecision(ScanDecision.UnsupportedExtension, uri, 'file create', `no owner for ${ext}`);
      return { submitted: false, providerNames: [], reason: 'file create', source: 'autoscan', skipReason: 'no owner for extension' };
    }
    const providerCfg = this._registry.getProviderConfig(ownerName);
    if (providerCfg && !providerCfg.autoScan) {
      this.logDecision(ScanDecision.AutoScanDisabled, uri, 'file create', `${ownerName}.autoScan=false`);
      return { submitted: false, providerNames: [], reason: 'file create', source: 'autoscan', skipReason: 'provider autoScan disabled' };
    }
    this.logDecision(ScanDecision.Accepted, uri, 'file create', `owner=${ownerName}`);
    return this.submit({ providerNames: [ownerName], reason: 'file create', source: 'autoscan', event: 'create', uris: [uri] });
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
    return this.submit({ providerNames: owners, reason: 'file rename', source: 'autoscan', event: 'rename', uris: [oldUri, newUri] });
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
    return this.submit({ providerNames: [ownerName], reason: 'file delete', source: 'autoscan', event: 'delete', uris: [uri] });
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
   * Delegates to JobQueue.cancelProviders() which handles pending, parked,
   * and ready entries. In-flight jobs are aborted via their AbortController.
   */
  cancelProviderJobs(providerNames: readonly string[]): void {
    this.ensureNotDisposed();
    const cancelled = this._queue.cancelProviders(providerNames, 'provider disabled/unregistered');
    for (const job of cancelled) {
      this._log(`[SCAN-SCHEDULER] cancelled job ${job.jobId} for [${providerNames.join(', ')}]`);
    }
  }

  /** Get current queue sizes for monitoring. Delegates to JobQueue. */
  getQueueSizes(): { pending: number; ready: number; inflight: number } {
    return this._queue.getSizes();
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
    // Dispose queue (cancels all pending/parked/ready jobs)
    this._queue.dispose();
    // Dispose dispatcher (clears lock state)
    this._dispatcher.dispose();
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('ScanScheduler is disposed');
    }
  }
}
