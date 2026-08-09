import { ScanType } from '@pe/core';
import type { ScanJob } from '@pe/core';
import { describe, expect, it } from 'vitest';
import { ProviderQueue } from '../src/index.js';
import { testUri } from './helpers.js';

function makeJob(overrides: Partial<ScanJob> = {}): ScanJob {
  return {
    id: 'job-1',
    capability: 'typescript',
    scope: 'file',
    type: ScanType.Save,
    uris: [testUri('C:/proj/src/a.ts')],
    priority: 'save',
    cost: 'medium',
    enqueuedMs: 0,
    ...overrides,
  };
}

describe('ProviderQueue', () => {
  it('returns the highest-priority job first (manual > save > startup)', () => {
    const queue = new ProviderQueue();
    queue.enqueue(makeJob({ id: 'startup', priority: 'startup', enqueuedMs: 10 }));
    queue.enqueue(makeJob({ id: 'save', priority: 'save', enqueuedMs: 20 }));
    queue.enqueue(makeJob({ id: 'manual', priority: 'manual', enqueuedMs: 30 }));
    expect(queue.peekHighestPriority()?.id).toBe('manual');
    expect(queue.dequeueHighestPriority()?.id).toBe('manual');
    expect(queue.dequeueHighestPriority()?.id).toBe('save');
    expect(queue.dequeueHighestPriority()?.id).toBe('startup');
    expect(queue.size).toBe(0);
  });

  it('breaks priority ties by FIFO order', () => {
    const queue = new ProviderQueue();
    queue.enqueue(makeJob({ id: 'first', enqueuedMs: 1 }));
    queue.enqueue(makeJob({ id: 'second', enqueuedMs: 2 }));
    expect(queue.dequeueHighestPriority()?.id).toBe('first');
  });

  it('refuses to grow past the bound (default 100)', () => {
    const queue = new ProviderQueue();
    for (let i = 0; i < 100; i += 1) {
      expect(queue.enqueue(makeJob({ id: `job-${i}` }))).toBe(true);
    }
    expect(queue.enqueue(makeJob({ id: 'overflow' }))).toBe(false);
    expect(queue.size).toBe(100);
  });

  it('find returns the queued job for a capability + scope', () => {
    const queue = new ProviderQueue();
    const job = makeJob({ id: 'save-ts' });
    queue.enqueue(job);
    expect(queue.find('typescript', 'file')).toBe(job);
    expect(queue.find('typescript', 'workspace')).toBeUndefined();
    expect(queue.find('python', 'file')).toBeUndefined();
  });

  it('remove deletes a job by id', () => {
    const queue = new ProviderQueue();
    queue.enqueue(makeJob({ id: 'a' }));
    queue.enqueue(makeJob({ id: 'b' }));
    expect(queue.remove('a')).toBe(true);
    expect(queue.remove('a')).toBe(false);
    expect(queue.size).toBe(1);
  });

  it('snapshot is a frozen copy and clear empties the queue', () => {
    const queue = new ProviderQueue();
    queue.enqueue(makeJob({ id: 'a' }));
    const snapshot = queue.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.snapshot()).toHaveLength(0);
  });
});
