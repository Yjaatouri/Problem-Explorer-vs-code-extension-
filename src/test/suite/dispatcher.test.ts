import * as assert from 'assert';
import { Uri } from 'vscode';
import { Dispatcher, DispatcherListener } from '../../scanner/Dispatcher';
import { ScanJobRequest } from '../../scanner/ScanJob';

/**
 * Dispatcher unit tests (T2).
 *
 * Exercises the two invariants that make the dispatcher safe:
 *  - INV‑1: ≤1 in‑flight scan per provider (same‑provider scans serialize)
 *  - cross‑provider concurrency (different providers run in parallel)
 *
 * Uses a controllable refresh fn that tracks concurrent execution counts and
 * can be made slow, so we can observe serialization vs. overlap directly.
 */

const file1 = Uri.parse('file:///workspace/src/a.ts');
const file2 = Uri.parse('file:///workspace/src/b.ts');

interface FakeRefresh {
  /** Map of provider -> number of currently executing calls. */
  active: Map<string, number>;
  /** Max simultaneous same‑provider executions observed. */
  maxSameProviderConcurrent: number;
  /** Set of providers observed running simultaneously (concurrency probe). */
  simultaneousSeen: Set<string>[];
  /** Optional per‑provider delay. */
  delays: Map<string, number>;
  calls: Array<{ providers: string[]; uris: Uri[] }>;
}

function makeRefresh(): { fn: (p: readonly string[], u: readonly Uri[]) => Promise<void>; state: FakeRefresh } {
  const state: FakeRefresh = {
    active: new Map(),
    maxSameProviderConcurrent: 0,
    simultaneousSeen: [],
    delays: new Map(),
    calls: [],
  };
  const fn = async (providers: readonly string[], uris: readonly Uri[]): Promise<void> => {
    state.calls.push({ providers: [...providers], uris: [...uris] });
    // Register this call's providers as active FIRST, then snapshot — so the
    // overlap window (both providers active simultaneously) is captured even
    // though each call enters/exits independently.
    for (const p of providers) {
      const cur = (state.active.get(p) ?? 0) + 1;
      state.active.set(p, cur);
      state.maxSameProviderConcurrent = Math.max(state.maxSameProviderConcurrent, cur);
    }
    const activeNow = new Set<string>();
    for (const [p, n] of state.active) if (n > 0) activeNow.add(p);
    state.simultaneousSeen.push(activeNow);

    const delay = Math.max(...providers.map((p) => state.delays.get(p) ?? 0));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    for (const p of providers) {
      state.active.set(p, (state.active.get(p) ?? 1) - 1);
    }
  };
  return { fn, state };
}

class Rec implements DispatcherListener {
  starts: string[] = [];
  finishes: Array<{ provider: string; success: boolean }> = [];
  onProviderStart = (p: string) => this.starts.push(p);
  onProviderFinish = (p: string, _ms: number, success: boolean) =>
    this.finishes.push({ provider: p, success });
}

const req = (providers: string[], uris: Uri[] = []): ScanJobRequest => ({
  providerNames: providers,
  reason: 'test',
  source: 'autoscan',
  uris,
});

suite('Dispatcher', () => {
  test('two same‑provider jobs never overlap (INV‑1: per‑provider serialization)', async () => {
    const { fn, state } = makeRefresh();
    state.delays.set('tsc', 30);
    const d = new Dispatcher(fn, () => {});
    const ac = new AbortController();

    // Fire two jobs for tsc without waiting between them.
    const p1 = d.execute(req(['tsc'], [file1]), ac.signal);
    const p2 = d.execute(req(['tsc'], [file2]), ac.signal);
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.ok(r1.success && r2.success);
    assert.strictEqual(state.maxSameProviderConcurrent, 1, 'tsc never ran twice at once');
    // Both calls happened, serialized.
    assert.strictEqual(state.calls.filter((c) => c.providers[0] === 'tsc').length, 2);
    d.dispose();
  });

  test('different providers run concurrently (cross‑provider parallelism)', async () => {
    const { fn, state } = makeRefresh();
    state.delays.set('tsc', 30);
    state.delays.set('eslint', 30);
    const d = new Dispatcher(fn, () => {});
    const ac = new AbortController();

    await Promise.all([
      d.execute(req(['tsc'], [file1]), ac.signal),
      d.execute(req(['eslint'], [file2]), ac.signal),
    ]);

    // At some point both were active together.
    const overlap = state.simultaneousSeen.some((s) => s.has('tsc') && s.has('eslint'));
    assert.ok(overlap, 'tsc and eslint should have overlapped');
    d.dispose();
  });

  test('abort before start is a no‑op (does not call refresh)', async () => {
    const { fn, state } = makeRefresh();
    const d = new Dispatcher(fn, () => {});
    const ac = new AbortController();
    ac.abort();
    const res = await d.execute(req(['tsc']), ac.signal);
    assert.strictEqual(state.calls.length, 0, 'aborted job must not execute');
    assert.ok(res.success);
    d.dispose();
  });

  test('abort while waiting for the lock skips that provider', async () => {
    const { fn, state } = makeRefresh();
    state.delays.set('tsc', 40);
    const d = new Dispatcher(fn, () => {});
    // First job holds the lock for 40ms.
    const p1 = d.execute(req(['tsc'], [file1]), new AbortController().signal);
    // Second job waits for the lock; abort it ~10ms in.
    const ac2 = new AbortController();
    const p2 = d.execute(req(['tsc'], [file2]), ac2.signal);
    setTimeout(() => ac2.abort(), 10);
    await Promise.all([p1, p2]);
    // Only the first job's refresh should have actually run.
    assert.strictEqual(state.calls.length, 1, 'second job skipped after abort');
    d.dispose();
  });

  test('a failed provider marks the job failed but does not reject', async () => {
    let calls = 0;
    const fn = async (providers: readonly string[]): Promise<void> => {
      calls++;
      if (providers[0] === 'tsc') throw new Error('boom');
    };
    const d = new Dispatcher(fn, () => {});
    const res = await d.execute(req(['tsc']), new AbortController().signal);
    assert.strictEqual(calls, 1);
    assert.ok(!res.success);
    assert.strictEqual(res.error?.message, 'boom');
    d.dispose();
  });

  test('isRunning reflects in‑flight providers', async () => {
    const { fn, state } = makeRefresh();
    state.delays.set('tsc', 30);
    const d = new Dispatcher(fn, () => {});
    const done = d.execute(req(['tsc']), new AbortController().signal);
    // Give it a tick to enter the lock.
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(d.isRunning('tsc'));
    await done;
    assert.ok(!d.isRunning('tsc'));
    assert.strictEqual(d.runningCount, 0);
    d.dispose();
  });

  test('listener receives start/finish for each provider', async () => {
    const { fn } = makeRefresh();
    const rec = new Rec();
    const d = new Dispatcher(fn, () => {}, rec);
    await d.execute(req(['tsc', 'eslint']), new AbortController().signal);
    assert.strictEqual(rec.starts.length, 2);
    assert.strictEqual(rec.finishes.length, 2);
    assert.ok(rec.finishes.every((f) => f.success));
    d.dispose();
  });
});
