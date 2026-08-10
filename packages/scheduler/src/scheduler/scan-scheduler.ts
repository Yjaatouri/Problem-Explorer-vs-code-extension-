// ScanScheduler — purely mechanical dispatch (§5.5, §7.4.3–4, §8.2).
//
// Accepts ScanPlans, decides when / in what order / with what concurrency.
// It never learns WHY a scan is needed (that is the ImpactAnalyzer's job),
// never references provider IDs, and never runs scans itself — it delegates
// to the ProviderRegistry, which re-checks health before every dispatch.
//
// Concurrency slots (§8.1): cheap 4, medium 2, expensive 1. Queue bound: 100
// (overflow drops the job and fires onQueueOverflow — never unbounded).

import { ScanType, TypedEventEmitter } from '@pe/core';
import type {
  Cost,
  ScanJob,
  ScanPlan,
  ScanPriority,
  ScanQueueOverflowEvent,
  ScanResult,
  ScanStateEvent,
  ScanJobCompleteEvent,
  ScanJobFailedEvent,
  Uri,
} from '@pe/core';
import { ProviderRegistry, withTimeout } from '../registry/provider-registry.js';
import { ProviderQueue } from './provider-queue.js';

const DEFAULT_CONCURRENCY: Record<Cost, number> = { cheap: 4, medium: 2, expensive: 1 };

/** Manual > Save > Periodic > Startup (§8.2). */
const TYPE_BY_PRIORITY: Record<ScanPriority, ScanType> = {
  manual: ScanType.Manual,
  save: ScanType.Save,
  periodic: ScanType.Periodic,
  startup: ScanType.Startup,
};

const TRIGGER_BY_TYPE: Record<ScanType, ScanContextTrigger> = {
  startup: 'startup',
  save: 'save',
  manual: 'manual',
  periodic: 'timer',
};

type ScanContextTrigger = 'startup' | 'save' | 'manual' | 'timer' | 'config-change';

export interface ScanSchedulerOptions {
  readonly registry: ProviderRegistry;
  /** Overrides per cost class; missing classes keep the defaults. */
  readonly maxConcurrency?: Partial<Record<Cost, number>>;
  readonly queueSize?: number;
  readonly idleWindowMs?: number;
  readonly scanTimeoutMs?: number;
  readonly now?: () => number;
}

export class ScanScheduler {
  private readonly registry: ProviderRegistry;
  private readonly maxConcurrency: Record<Cost, number>;
  private readonly idleWindowMs: number;
  private readonly scanTimeoutMs: number;
  private readonly now: () => number;
  private readonly queue: ProviderQueue;
  private readonly completeEmitter = new TypedEventEmitter<ScanJobCompleteEvent>();
  private readonly failedEmitter = new TypedEventEmitter<ScanJobFailedEvent>();
  private readonly overflowEmitter = new TypedEventEmitter<ScanQueueOverflowEvent>();
  private readonly stateEmitter = new TypedEventEmitter<ScanStateEvent>();
  private readonly running = new Map<Cost, number>();
  private readonly runningCapabilities = new Set<ScanPlan['capability']>();
  private readonly statusDisposable;
  private nextJobId = 1;
  private lastFinishedMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pumping = false;
  /** A pump was requested while one was in flight — re-run after it ends (§7.4.4). */
  private repumpPending = false;
  private disposed = false;

  constructor(options: ScanSchedulerOptions) {
    this.registry = options.registry;
    this.maxConcurrency = { ...DEFAULT_CONCURRENCY, ...options.maxConcurrency };
    this.queue = new ProviderQueue({ maxSize: options.queueSize ?? 100 });
    this.idleWindowMs = options.idleWindowMs ?? 5000;
    this.scanTimeoutMs = options.scanTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.statusDisposable = this.registry.onStatusChanged(() => this.pump());
  }

  /** Event: a scan job completed (result carries the per-file diagnostics). */
  readonly onScanJobComplete = this.completeEmitter.on.bind(this.completeEmitter);

  /** Event: a scan job failed (timeout or provider error). */
  readonly onScanJobFailed = this.failedEmitter.on.bind(this.failedEmitter);

  /** Event: a job was dropped because the queue hit its bound. */
  readonly onQueueOverflow = this.overflowEmitter.on.bind(this.overflowEmitter);

  /** Event: idle/scanning snapshot with running + queued counts. */
  readonly onScanStateChanged = this.stateEmitter.on.bind(this.stateEmitter);

  /** A provider health change can unblock queued jobs — re-pump (§5.5). */
  /** Accept a plan from the ImpactAnalyzer (§7.4.3: merge, don't duplicate). */
  enqueue(plan: ScanPlan): void {
    if (this.disposed) {
      return;
    }
    const job = this.makeJob(plan);
    const existing = this.queue.find(job.capability, job.scope);
    if (existing !== undefined) {
      const union = this.unionUris(existing.uris, job.uris);
      if (union.length === 0) {
        // Superseded: the merged URI set is empty → cancel the queued job (§7.4.3).
        this.queue.remove(existing.id);
      } else {
        this.queue.remove(existing.id);
        this.queue.enqueue({
          ...existing,
          uris: union,
          priority: this.higherPriority(existing.priority, job.priority),
        });
      }
      this.emitState();
      this.pump();
      return;
    }
    if (plan.scope === 'workspace') {
      this.cancelCoveredFileJobs(plan);
    }
    if (!this.queue.enqueue(job)) {
      this.overflowEmitter.fire({ job });
      return;
    }
    this.emitState();
    this.pump();
  }

  get queuedCount(): number {
    return this.queue.size;
  }

  get runningCount(): number {
    let total = 0;
    for (const count of this.running.values()) {
      total += count;
    }
    return total;
  }

  /** Queued jobs (frozen snapshot; for observability/tests). */
  snapshot(): readonly ScanJob[] {
    return this.queue.snapshot();
  }

  /** Drop queued work. Running jobs are never interrupted (§7.4.3). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.statusDisposable.dispose();
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.queue.clear();
    this.emitState();
  }

  private makeJob(plan: ScanPlan): ScanJob {
    const capability = plan.capability;
    const primary = this.registry.getByCapability(capability)[0];
    return {
      id: `job-${this.nextJobId++}`,
      capability,
      scope: plan.scope,
      type: TYPE_BY_PRIORITY[plan.priority],
      uris: [...plan.uris],
      priority: plan.priority,
      cost: primary?.capabilities.cost ?? 'medium',
      enqueuedMs: this.now(),
    };
  }

  private unionUris(a: readonly Uri[], b: readonly Uri[]): Uri[] {
    const seen = new Set<string>();
    const result: Uri[] = [];
    for (const uri of [...a, ...b]) {
      const key = uri.toString();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(uri);
      }
    }
    return result;
  }

  private higherPriority(a: ScanPriority, b: ScanPriority): ScanPriority {
    const rank = { manual: 0, save: 1, periodic: 2, startup: 3 } as const;
    return rank[a] <= rank[b] ? a : b;
  }

  /** A workspace rescan covers the same capability's queued single-file jobs (§7.4.3). */
  private cancelCoveredFileJobs(plan: ScanPlan): void {
    for (const job of this.queue.snapshot()) {
      if (job.scope === 'file' && job.capability === plan.capability) {
        this.queue.remove(job.id);
      }
    }
  }

  private pump(): void {
    if (this.pumping) {
      this.repumpPending = true;
      return;
    }
    this.pumping = true;
    try {
      this.drainQueue();
    } finally {
      this.pumping = false;
      if (this.repumpPending) {
        this.repumpPending = false;
        this.pump();
      }
    }
  }

  private drainQueue(): void {
    // Priority order (manual → … → startup, FIFO within a tier). One pass:
    // an unhealthy head job is left queued for a later health change instead
    // of stalling the whole queue (§5.5).
    for (const job of this.queue.inPriorityOrder()) {
      if (job.priority === 'periodic') {
        if (!this.isIdleForPeriodic()) {
          this.armIdleWatch(); // one idle-watch timer (§7.4.4)
          break;
        }
      }
      if (this.runningCapabilities.has(job.capability)) {
        break; // one running job per capability (§7.4.3: no duplicate work)
      }
      const provider = this.readyProviderFor(job.capability);
      if (provider === undefined) {
        const candidates = this.registry.getByCapability(job.capability);
        if (candidates.length === 0) {
          // Nothing can ever run this job — drop it so it never starves others (§7.2.2).
          this.queue.remove(job.id);
          continue;
        }
        // Health may have drifted since registration — re-check; the job
        // stays queued and a health change re-pumps it (§5.5).
        void this.registry.healthCheckAll();
        continue;
      }
      const cost = provider.capabilities.cost;
      if (!this.hasFreeSlot(cost)) {
        break;
      }
      this.queue.remove(job.id);
      this.allocateSlot(cost);
      this.runningCapabilities.add(job.capability);
      this.emitState();
      void this.run(job, provider.id, cost);
    }
  }

  /**
   * The single idle-watch timer (§7.4.4): when a periodic job is queued but
   * the workspace is not yet idle, re-pump after the idle window.
   */
  private armIdleWatch(): void {
    if (this.idleTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      this.pump();
    }, this.idleWindowMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private isIdleForPeriodic(): boolean {
    const nonPeriodic = this.queue.snapshot().some((job) => job.priority !== 'periodic');
    return (
      !nonPeriodic &&
      this.runningCount === 0 &&
      this.now() - this.lastFinishedMs >= this.idleWindowMs
    );
  }

  private readyProviderFor(capability: ScanPlan['capability']) {
    for (const provider of this.registry.getByCapability(capability)) {
      if (this.registry.getStatus(provider.id)?.health === 'ready') {
        return provider;
      }
    }
    return undefined;
  }

  private hasFreeSlot(cost: Cost): boolean {
    const used = this.running.get(cost) ?? 0;
    return used < (this.maxConcurrency[cost] ?? DEFAULT_CONCURRENCY[cost]);
  }

  private allocateSlot(cost: Cost): void {
    this.running.set(cost, (this.running.get(cost) ?? 0) + 1);
  }

  private freeSlot(cost: Cost): void {
    const used = (this.running.get(cost) ?? 1) - 1;
    if (used <= 0) {
      this.running.delete(cost);
    } else {
      this.running.set(cost, used);
    }
  }

  private async run(job: ScanJob, providerId: string, cost: Cost): Promise<void> {
    this.registry.markScanning(providerId);
    let result: ScanResult | undefined;
    let error: Error | undefined;
    try {
      result = await withTimeout(
        this.registry.getById(providerId)!.scan({
          type: job.type,
          trigger: TRIGGER_BY_TYPE[job.type],
          uris: job.uris,
          providerId,
        }),
        this.scanTimeoutMs,
        `scan timed out after ${this.scanTimeoutMs}ms`,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    this.freeSlot(cost);
    this.runningCapabilities.delete(job.capability);
    this.lastFinishedMs = this.now();
    if (error !== undefined) {
      this.registry.finishScan(providerId, false, error);
      this.failedEmitter.fire({ job, providerId, error });
    } else {
      this.registry.finishScan(providerId, true);
      this.completeEmitter.fire({ job, providerId, result: result! });
    }
    this.emitState();
    this.pump();
  }

  private emitState(): void {
    const running = this.runningCount;
    this.stateEmitter.fire({
      phase: running > 0 ? 'scanning' : 'idle',
      running,
      queued: this.queue.size,
    });
  }
}
