import * as assert from 'assert';
import { debounce } from '../../performance/debounce';
import { throttle } from '../../performance/throttle';
import { batch } from '../../performance/batch';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('debounce', () => {
  test('calls function after the delay', async () => {
    let callCount = 0;
    const fn = debounce(() => { callCount++; }, 30);
    fn();
    assert.strictEqual(callCount, 0);
    await wait(60);
    assert.strictEqual(callCount, 1);
  });

  test('multiple rapid calls only trigger once', async () => {
    let callCount = 0;
    const fn = debounce(() => { callCount++; }, 30);
    fn();
    fn();
    fn();
    await wait(60);
    assert.strictEqual(callCount, 1);
  });

  test('uses the last arguments', async () => {
    let lastArg = '';
    const fn = debounce((s: string) => { lastArg = s; }, 30);
    fn('a');
    fn('b');
    fn('c');
    await wait(60);
    assert.strictEqual(lastArg, 'c');
  });

  test('cancel prevents execution', async () => {
    let callCount = 0;
    const fn = debounce(() => { callCount++; }, 30);
    fn();
    fn.cancel();
    await wait(60);
    assert.strictEqual(callCount, 0);
  });

  test('flush immediately executes pending call', () => {
    let callCount = 0;
    const fn = debounce(() => { callCount++; }, 1000);
    fn();
    fn.flush();
    assert.strictEqual(callCount, 1);
  });

  test('flush with no pending call does nothing', () => {
    const fn = debounce(() => { throw new Error('should not be called'); }, 1000);
    fn.flush();
  });

  test('cancel resets so next call schedules fresh', async () => {
    let callCount = 0;
    const fn = debounce(() => { callCount++; }, 30);
    fn();
    fn.cancel();
    await wait(60);
    assert.strictEqual(callCount, 0);
  });
});

suite('throttle', () => {
  test('calls immediately on first invocation', () => {
    let callCount = 0;
    const fn = throttle(() => { callCount++; }, 100);
    fn();
    assert.strictEqual(callCount, 1);
  });

  test('subsequent calls within interval are throttled', () => {
    let callCount = 0;
    const fn = throttle(() => { callCount++; }, 100);
    fn();
    fn();
    fn();
    assert.strictEqual(callCount, 1);
  });

  test('trailing edge call fires after interval', async () => {
    let callCount = 0;
    const fn = throttle(() => { callCount++; }, 50);
    fn();
    fn();
    await wait(80);
    assert.strictEqual(callCount, 2);
  });

  test('leading: false defers first call to trailing edge', async () => {
    let callCount = 0;
    const fn = throttle(() => { callCount++; }, 50, { leading: false, trailing: true });
    fn();
    assert.strictEqual(callCount, 0);
    await wait(80);
    assert.strictEqual(callCount, 1);
  });

  test('trailing: false skips trailing call', async () => {
    let callCount = 0;
    const fn = throttle(() => { callCount++; }, 50, { leading: true, trailing: false });
    fn();
    fn();
    assert.strictEqual(callCount, 1);
    await wait(80);
    assert.strictEqual(callCount, 1);
  });

  test('cancel clears pending trailing call', async () => {
    let callCount = 0;
    const fn = throttle(() => { callCount++; }, 50);
    fn();
    fn();
    fn.cancel();
    await wait(80);
    assert.strictEqual(callCount, 1);
  });

  test('passes arguments through', () => {
    let result = 0;
    const fn = throttle((n: number) => { result = n; }, 100);
    fn(42);
    assert.strictEqual(result, 42);
  });
});

suite('batch', () => {
  test('collects items and calls function after delay', async () => {
    const items: number[] = [];
    const c = batch<number>((chunk) => items.push(...chunk), 30);
    c.add(1);
    c.add(2);
    await wait(60);
    assert.deepStrictEqual(items, [1, 2]);
  });

  test('multiple adds within window are batched together', async () => {
    const batches: number[][] = [];
    const c = batch<number>((chunk) => batches.push(chunk), 30);
    c.add(1);
    await wait(10);
    c.add(2);
    await wait(10);
    c.add(3);
    await wait(60);
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(batches[0], [1, 2, 3]);
  });

  test('flush immediately executes with all items', () => {
    const items: number[] = [];
    const c = batch<number>((chunk) => items.push(...chunk), 1000);
    c.add(1);
    c.add(2);
    c.flush();
    assert.deepStrictEqual(items, [1, 2]);
  });

  test('cancel clears pending items', async () => {
    const items: number[] = [];
    const c = batch<number>((chunk) => items.push(...chunk), 30);
    c.add(1);
    c.cancel();
    await wait(60);
    assert.strictEqual(items.length, 0);
  });

  test('flush with empty queue does nothing', () => {
    const c = batch<number>(() => { throw new Error('should not be called'); }, 1000);
    c.flush();
  });

  test('batch resets after flush', async () => {
    const batches: number[][] = [];
    const c = batch<number>((chunk) => batches.push(chunk), 30);
    c.add(1);
    c.flush();
    c.add(2);
    c.add(3);
    c.flush();
    assert.strictEqual(batches.length, 2);
    assert.deepStrictEqual(batches[0], [1]);
    assert.deepStrictEqual(batches[1], [2, 3]);
  });
});
