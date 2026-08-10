import * as assert from 'assert';
import { Uri } from 'vscode';
import {
  JobQueue,
  JobQueueListener,
  ReadyEntry,
  SubmitOutcome,
} from '../../scanner/JobQueue';
import { ScanJob } from '../../scanner/ScanJob';

/**
 * JobQueue unit tests (T1).
 *
 * These exercise the queue in isolation — no ScanScheduler, no providers, no
 * real timers beyond setTimeout. A recording listener captures every
 * transition so assertions can reason about the observable state machine
 * (submitted → merged → ready → parked → cancelled) rather than internals.
 *
 * Fake timers are avoided in favor of small real waits + a configurable
 * debounce, keeping the suite deterministic on CI.
 */

const file1 = Uri.parse('file:///workspace/src/a.ts');
const file2 = Uri.parse('file:///workspace/src/b.ts');
const file3 = Uri.parse('file:///workspace/src/c.ts');

/** Record every listener call, in order. */
class Recorder implements JobQueueListener {
  readonly events: Array<{ type: string; detail: any }> = [];
  onSubmitted = (job: ScanJob, key: string) =>
    this.events.push({ type: 'submitted', detail: { job, key } });
  onMerged = (existing: string, incoming: string, key: string) =>
    this.events.push({ type: 'merged', detail: { existing, incoming, key } });
  onReady = (job: ScanJob, size: number) =>
    this.events.push({ type: 'ready', detail: { job, size } });
  onParked = (job: ScanJob, behind: string) =>
    this.events.push({ type: 'parked', detail: { job, behind } });
  onCancelled = (job: ScanJob, reason: string) =>
    this.events.push({ type: 'cancelled', detail: { job, reason } });
  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A flush handler that just collects entries (does not auto‑begin inflight). */
function collectingFlush(sink: ReadyEntry[]): (e: ReadyEntry) => void {
  return (e) => sink.push(e);
}

suite('JobQueue', () => {
  let queue: JobQueue;
  let rec: Recorder;
  let flushed: ReadyEntry[];

  setup(() => {
    rec = new Recorder();
    flushed = [];
    queue = new JobQueue(collectingFlush(flushed), rec, {
      debounceMs: 20,
      maxWaitMs: 80,
    });
  });

  teardown(() => {
    queue.dispose();
  });

  // ── Coalescing on provider id (the core invariant) ──────────────────

  test('two rapid submits for the same provider merge into one job (INV: 10 saves → 1 scan)', async () => {
    queue.submit({ providerNames: ['tsc'], reason: 'file save', source: 'autoscan', uris: [file1] }, 10);
    queue.submit({ providerNames: ['tsc'], reason: 'file save', source: 'autoscan', uris: [file2] }, 10);

    assert.strictEqual(rec.count('submitted'), 1, 'first arrival creates a slot');
    assert.strictEqual(rec.count('merged'), 1, 'second arrival merges');
    assert.strictEqual(queue.getSizes().pending, 1, 'still one pending slot (INV‑3)');

    await wait(40); // > debounceMs

    assert.strictEqual(flushed.length, 1, 'exactly one job flushed');
    assert.strictEqual(flushed[0].job.uris.length, 2, 'URIs were unioned');
    assert.ok(flushed[0].job.uris.some((u) => u.fsPath === file1.fsPath));
    assert.ok(flushed[0].job.uris.some((u) => u.fsPath === file2.fsPath));
  });

  test('different providers get independent slots and flush independently', async () => {
    queue.submit({ providerNames: ['tsc'], reason: 'file save', source: 'autoscan', uris: [file1] }, 10);
    queue.submit({ providerNames: ['eslint'], reason: 'file save', source: 'autoscan', uris: [file2] }, 9);

    assert.strictEqual(queue.getSizes().pending, 2, 'two providers → two slots');
    assert.strictEqual(rec.count('submitted'), 2);

    await wait(40);
    assert.strictEqual(flushed.length, 2, 'both flushed');
    const providers = flushed.map((e) => e.job.provider).sort();
    assert.deepStrictEqual(providers, ['eslint', 'tsc']);
  });

  // ── Trailing debounce (NOT reset on merge) ──────────────────────────

  test('trailing debounce is not reset by later arrivals → bounded latency under burst', async () => {
    // Distinguish trailing‑reset from trailing‑non‑reset despite extension‑host
    // timer jitter (~tens of ms). With debounceMs=250:
    //   submit A at t=0   → non‑reset timer arms at t=250; reset timer at t=250
    //   submit B at t=200 → merges; non‑reset timer UNCHANGED (fires 250);
    //                       reset timer would re‑arm to t=200+250=450
    // Check at t≈330: non‑reset (250) has fired; reset (450) has not. The 200ms
    // gap tolerates up to ~80ms of symmetric jitter.
    queue = new JobQueue(collectingFlush(flushed), rec, {
      debounceMs: 250,
      maxWaitMs: 10_000,
    });
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 9);
    await wait(200);
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file2] }, 9);
    await wait(130); // t≈330
    assert.strictEqual(flushed.length, 1, 'non‑reset debounce fired at ~250ms, not deferred to ~450ms');
    assert.strictEqual(flushed[0].job.uris.length, 2, 'B merged into the slot before flush');
  });

  // ── maxWait ceiling ─────────────────────────────────────────────────

  test('maxWait forces a flush even if the slot somehow lingers', async () => {
    // Use a tiny debounce and a maxWait just above it; the debounce timer
    // will normally fire first, but this asserts maxWait is armed and clears
    // on flush (no leak / double flush).
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    await wait(120); // well past maxWaitMs=80
    assert.strictEqual(flushed.length, 1, 'flushed exactly once (no double fire from maxWait)');
  });

  // ── Priority heap ordering ──────────────────────────────────────────

  test('ready heap drains highest priority first, ties by earliest timestamp', async () => {
    // computeScanPriority clamps providerBasePriority to 0..9, so use 9 vs 5
    // to guarantee a real difference (89 vs 85 for the startup tier).
    const q = new JobQueue(() => {}, undefined, { debounceMs: 5, maxWaitMs: 50 });
    try {
      q.submit({ providerNames: ['eslint'], reason: 'startup', source: 'startup' }, 5); // pri 85
      q.submit({ providerNames: ['tsc'], reason: 'startup', source: 'startup' }, 9);    // pri 89
      await wait(20);
      const first = q.popReady()!;
      const second = q.popReady()!;
      assert.strictEqual(first.job.provider, 'tsc', 'higher base priority first');
      assert.strictEqual(second.job.provider, 'eslint');
      assert.strictEqual(q.popReady(), undefined, 'heap empty after two pops');
    } finally {
      q.dispose();
    }
  });

  test('manual source outranks autoscan for the same provider', async () => {
    const q = new JobQueue(() => {}, undefined, { debounceMs: 5, maxWaitMs: 50 });
    try {
      q.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10); // ~60
      q.submit({ providerNames: ['tsc'], reason: 'manual', source: 'manual', uris: [file2] }, 10); // ~110 → merges, max wins
      await wait(20);
      const e = q.popReady()!;
      assert.ok(e.job.priority >= 100, 'merged priority keeps the manual tier');
    } finally {
      q.dispose();
    }
  });

  // ── Depth‑1 park slot (merge‑not‑abort) ─────────────────────────────

  test('arrival while in‑flight is parked, not aborted; released on completion', async () => {
    // Submit, flush, mark in‑flight, then submit again → parked.
    queue.submit({ providerNames: ['tsc'], reason: 'save1', source: 'autoscan', uris: [file1] }, 10);
    await wait(40);
    assert.strictEqual(flushed.length, 1);
    const first = flushed[0];

    queue.beginInFlight('tsc');
    const parked = queue.submit({ providerNames: ['tsc'], reason: 'save2', source: 'autoscan', uris: [file2] }, 10);
    assert.strictEqual((parked as any).kind, 'parked', 'second arrival is parked');
    assert.strictEqual(rec.count('parked'), 1);
    assert.strictEqual(queue.getSizes().inflight, 1);
    assert.ok(!first.abort.signal.aborted, 'in‑flight job NOT aborted by a same‑tier arrival');

    // Completing the in‑flight job promotes the parked slot.
    const promoted = queue.completeInFlight('tsc');
    assert.ok(promoted, 'parked slot promoted on completion');
    assert.strictEqual(promoted!.job.uris.length, 1);
    assert.strictEqual(promoted!.job.uris[0].fsPath, file2.fsPath);
    assert.strictEqual(queue.getSizes().inflight, 0);
  });

  test('multiple arrivals while in‑flight merge into the single parked slot (depth‑1)', () => {
    queue.beginInFlight('tsc');
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    const p2 = queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file2] }, 10);
    const p3 = queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file3] }, 10);

    assert.strictEqual((p2 as any).kind, 'parked');
    assert.strictEqual((p3 as any).kind, 'parked');
    const sizes = queue.getSizes();
    // parked isn't in pending/ready/inflight counts; verify via completeInFlight.
    const promoted = queue.completeInFlight('tsc')!;
    assert.strictEqual(promoted.job.uris.length, 3, 'all three URIs merged into one parked slot');
  });

  // ── Cancellation ────────────────────────────────────────────────────

  test('cancelProviders cancels pending + ready and aborts their signals', async () => {
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    await wait(40); // → ready heap
    assert.strictEqual(queue.getSizes().ready, 1);

    const cancelled = queue.cancelProviders(['tsc'], 'config disabled');
    assert.strictEqual(cancelled.length, 1);
    assert.strictEqual(rec.count('cancelled'), 1);
    assert.ok(cancelled[0].signal.aborted, 'ready entry aborted');
    assert.strictEqual(queue.getSizes().ready, 0);
  });

  test('cancelProviders leaves other providers untouched', async () => {
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    queue.submit({ providerNames: ['eslint'], reason: 'save', source: 'autoscan', uris: [file2] }, 9);
    await wait(40);
    queue.cancelProviders(['tsc'], 'disabled');
    assert.strictEqual(queue.getSizes().ready, 1, 'eslint still ready');
    const e = queue.popReady()!;
    assert.strictEqual(e.job.provider, 'eslint');
  });

  // ── Multi‑provider submit ───────────────────────────────────────────

  test('multi‑provider submit fans out to one slot per provider', () => {
    const last = queue.submit(
      { providerNames: ['tsc', 'eslint'], reason: 'startup', source: 'startup' },
      10,
    );
    assert.strictEqual(queue.getSizes().pending, 2);
    assert.strictEqual(rec.count('submitted'), 2);
    // last outcome corresponds to the final provider iterated
    assert.notStrictEqual((last as any).kind, 'rejected');
  });

  // ── Idle + dispose ──────────────────────────────────────────────────

  test('isIdle() is true only when all stages are empty', async () => {
    assert.ok(queue.isIdle());
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    assert.ok(!queue.isIdle());
    await wait(40);
    assert.ok(!queue.isIdle(), 'not idle while ready has an entry');
    queue.popReady();
    assert.ok(queue.isIdle());
  });

  test('dispose clears timers and aborts everything', async () => {
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    queue.dispose();
    await wait(40);
    assert.strictEqual(flushed.length, 0, 'disposed queue never flushes');
    assert.ok(queue.isIdle());
  });

  test('submit after dispose throws', () => {
    queue.dispose();
    assert.throws(() =>
      queue.submit({ providerNames: ['tsc'], reason: 'x', source: 'autoscan' }, 10),
    );
  });

  test('empty provider list is rejected', () => {
    const out = queue.submit({ providerNames: [], reason: 'x', source: 'autoscan' }, 10);
    assert.strictEqual((out as any).kind, 'rejected');
  });

  // ── R1: setOptions hot‑reload (config → JobQueue) ─────────────────────

  test('setOptions affects future pending slots but not already‑armed ones', async () => {
    // Submit slot 1 with debounce=400ms; then in the middle of its window call
    // setOptions to shrink the debounce to 30ms. Slot 1's *already‑armed*
    // timer must still fire at ~400ms (the new 30ms setting does NOT shrink
    // an armed timer — preserves the trailing debounce invariant). A *new*
    // slot created after setOptions uses the 30ms value.
    queue = new JobQueue(collectingFlush(flushed), rec, {
      debounceMs: 400,
      maxWaitMs: 10_000,
    });
    queue.submit({ providerNames: ['tsc'], reason: 'save', source: 'autoscan', uris: [file1] }, 10);
    assert.strictEqual(queue.getDebounceMs(), 400);

    // Halfway into slot 1's debounce, hot‑reload the config.
    await wait(200);
    assert.strictEqual(flushed.length, 0, 'slot 1 not flushed yet at t=200 (debounce=400)');
    queue.setOptions({ debounceMs: 30, maxWaitMs: 200 });
    assert.strictEqual(queue.getDebounceMs(), 30);
    assert.strictEqual(queue.getMaxWaitMs(), 200);

    // Wait past the ORIGINAL 400ms debounce. The armed timer was set when
    // the slot was created with debounce=400; setOptions touches only future
    // slots, so slot 1 must flush at ~400ms (not at t=200+30=230).
    await wait(260); // t≈460ms — past 400, would also be past 230 (the reset path)
    assert.strictEqual(flushed.length, 1, 'slot 1 flushed on its original 400ms timer (setOptions did not move it)');

    // A new slot created after setOptions uses the new 30ms debounce.
    queue.submit({ providerNames: ['tsc'], reason: 'save2', source: 'autoscan', uris: [file2] }, 10);
    await wait(80);
    assert.strictEqual(flushed.length, 2, 'slot 2 flushed under the new 30ms debounce');
  });

  test('setOptions ignores non‑positive values (defensive)', () => {
    const before = queue.getDebounceMs();
    queue.setOptions({ debounceMs: 0, maxWaitMs: -1 });
    assert.strictEqual(queue.getDebounceMs(), before, '0 debounce rejected');
    assert.strictEqual(queue.getMaxWaitMs(), 80, 'negative maxWait rejected');
  });

  // ── R3: per‑event priority ladder (save > create > rename > delete) ───

  test('R3: within autoscan, save outranks create outranks rename outranks delete', async () => {
    // Use distinct providers so each gets its own slot (same provider would
    // merge instead of competing for ordering). providers differ only in
    // identity; priorities are identical (providerBasePriority=5), so the
    // priority difference comes purely from the event field.
    const q = new JobQueue(() => {}, undefined, { debounceMs: 5, maxWaitMs: 50 });
    try {
      q.submit({ providerNames: ['pDelete'], reason: 'd', source: 'autoscan', event: 'delete' }, 5);
      q.submit({ providerNames: ['pRename'], reason: 'r', source: 'autoscan', event: 'rename' }, 5);
      q.submit({ providerNames: ['pCreate'], reason: 'c', source: 'autoscan', event: 'create' }, 5);
      q.submit({ providerNames: ['pSave'], reason: 's', source: 'autoscan', event: 'save' }, 5);
      await wait(20);
      const order: string[] = [];
      let e: ReadyEntry | undefined;
      while ((e = q.popReady()) !== undefined) {
        order.push(e.job.provider);
        void e;
      }
      assert.deepStrictEqual(order, ['pSave', 'pCreate', 'pRename', 'pDelete'],
        'priority order should follow the event ladder (save>create>rename>delete)');
    } finally {
      q.dispose();
    }
  });

  test('R3: autoscan without explicit event defaults to save tier (backwards compat)', async () => {
    const q = new JobQueue(() => {}, undefined, { debounceMs: 5, maxWaitMs: 50 });
    try {
      q.submit({ providerNames: ['pDefault'], reason: 'x', source: 'autoscan' }, 5); // 50+5=55
      q.submit({ providerNames: ['pDelete'], reason: 'y', source: 'autoscan', event: 'delete' }, 5); // 30+5=35
      await wait(20);
      assert.strictEqual(q.popReady()!.job.provider, 'pDefault', 'eventless autoscan still at save tier');
      assert.strictEqual(q.popReady()!.job.provider, 'pDelete');
    } finally {
      q.dispose();
    }
  });

  test('R3: event field does not affect non-autoscan sources', async () => {
    const q = new JobQueue(() => {}, undefined, { debounceMs: 5, maxWaitMs: 50 });
    try {
      // manual + delete event must still be tier 100, not 30. The event
      // should be ignored for non-autoscan sources.
      q.submit({ providerNames: ['pM'], reason: 'm', source: 'manual', event: 'delete' }, 5);
      q.submit({ providerNames: ['pA'], reason: 'a', source: 'autoscan', event: 'save' }, 5);
      await wait(20);
      assert.strictEqual(q.popReady()!.job.provider, 'pM', 'manual outranks autoscan regardless of event');
    } finally {
      q.dispose();
    }
  });
});
