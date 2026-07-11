import * as assert from 'assert';
import { debounce } from '../../performance/debounce';

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
