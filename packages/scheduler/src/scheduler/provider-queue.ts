// ProviderQueue — the scheduler's bounded job queue (§7.4.3, §8).
// Hard cap of 100 jobs; overflow is dropped and reported via
// ScanScheduler.onQueueOverflow — the queue itself never grows unbounded.
// Peek order is by priority (Manual > Save > Periodic > Startup), then
// FIFO within a priority. Merge logic lives in the scheduler (it needs the
// registry to classify); this class stays a dumb ordered store.

import type { ScanJob, ScanPriority } from '@pe/core';

const PRIORITY_RANK: Record<ScanPriority, number> = {
  manual: 0,
  save: 1,
  periodic: 2,
  startup: 3,
};

export interface ProviderQueueOptions {
  readonly maxSize?: number;
}

export class ProviderQueue {
  private readonly maxSize: number;
  private readonly jobs: ScanJob[] = [];

  constructor(options: ProviderQueueOptions = {}) {
    this.maxSize = options.maxSize ?? 100;
  }

  /** Push a job. Returns false (and does NOT store it) when at capacity. */
  enqueue(job: ScanJob): boolean {
    if (this.jobs.length >= this.maxSize) {
      return false;
    }
    this.jobs.push(job);
    return true;
  }

  /** First queued job matching capability + scope (for merge, §7.4.3). */
  find(capability: ScanJob['capability'], scope: ScanJob['scope']): ScanJob | undefined {
    return this.jobs.find(
      (job) => job.capability === capability && job.scope === scope && job.priority !== 'periodic',
    );
  }

  remove(jobId: string): boolean {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return false;
    }
    this.jobs.splice(index, 1);
    return true;
  }

  /** Highest-priority queued job (priority rank, then FIFO). */
  peekHighestPriority(): ScanJob | undefined {
    let best: ScanJob | undefined;
    for (const job of this.jobs) {
      if (
        best === undefined ||
        PRIORITY_RANK[job.priority] < PRIORITY_RANK[best.priority] ||
        (PRIORITY_RANK[job.priority] === PRIORITY_RANK[best.priority] &&
          job.enqueuedMs < best.enqueuedMs)
      ) {
        best = job;
      }
    }
    return best;
  }

  /** Remove the highest-priority job and return it (undefined when empty). */
  dequeueHighestPriority(): ScanJob | undefined {
    const job = this.peekHighestPriority();
    if (job !== undefined) {
      this.remove(job.id);
    }
    return job;
  }

  /** All queued jobs (frozen snapshot). */
  snapshot(): readonly ScanJob[] {
    return Object.freeze([...this.jobs]);
  }

  hasQueuedWork(): boolean {
    return this.jobs.length > 0;
  }

  get size(): number {
    return this.jobs.length;
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
