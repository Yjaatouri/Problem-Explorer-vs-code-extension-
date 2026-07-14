import * as assert from 'assert';
import { ProviderManager } from '../../services/ProviderManager';
import { IProblemProvider } from '../../providers/IProblemProvider';

class MockProvider implements IProblemProvider {
  startCount = 0;
  stopCount = 0;
  refreshCount = 0;
  disposed = false;

  start(): void { this.startCount++; }
  stop(): void { this.stopCount++; }
  refresh(): void { this.refreshCount++; }
  dispose(): void { this.disposed = true; }
}

suite('ProviderManager', () => {
  let manager: ProviderManager;

  setup(() => {
    manager = new ProviderManager();
  });

  test('register and get a provider', () => {
    const p = new MockProvider();
    manager.register('test', p);
    assert.strictEqual(manager.get('test'), p);
    assert.strictEqual(manager.size, 1);
  });

  test('register throws on duplicate name', () => {
    manager.register('dup', new MockProvider());
    assert.throws(() => manager.register('dup', new MockProvider()), /already registered/);
  });

  test('unregister removes and disposes provider', () => {
    const p = new MockProvider();
    manager.register('test', p);
    const result = manager.unregister('test');
    assert.strictEqual(result, true);
    assert.strictEqual(manager.get('test'), undefined);
    assert.strictEqual(p.disposed, true);
    assert.strictEqual(manager.size, 0);
  });

  test('unregister returns false for missing name', () => {
    assert.strictEqual(manager.unregister('nonexistent'), false);
  });

  test('startAll calls start on every provider', () => {
    const a = new MockProvider();
    const b = new MockProvider();
    manager.register('a', a);
    manager.register('b', b);
    manager.startAll();
    assert.strictEqual(a.startCount, 1);
    assert.strictEqual(b.startCount, 1);
  });

  test('stopAll calls stop on every provider', () => {
    const a = new MockProvider();
    const b = new MockProvider();
    manager.register('a', a);
    manager.register('b', b);
    manager.startAll();
    manager.stopAll();
    assert.strictEqual(a.stopCount, 1);
    assert.strictEqual(b.stopCount, 1);
  });

  test('refreshAll calls refresh on every provider', () => {
    const a = new MockProvider();
    const b = new MockProvider();
    manager.register('a', a);
    manager.register('b', b);
    manager.refreshAll();
    assert.strictEqual(a.refreshCount, 1);
    assert.strictEqual(b.refreshCount, 1);
  });

  test('dispose disposes all providers and clears the map', () => {
    const a = new MockProvider();
    const b = new MockProvider();
    manager.register('a', a);
    manager.register('b', b);
    manager.dispose();
    assert.strictEqual(a.disposed, true);
    assert.strictEqual(b.disposed, true);
    assert.strictEqual(manager.size, 0);
  });

  test('operations throw after dispose', () => {
    manager.dispose();
    assert.throws(() => manager.register('x', new MockProvider()), /disposed/);
    assert.throws(() => manager.startAll(), /disposed/);
    assert.throws(() => manager.stopAll(), /disposed/);
    assert.throws(() => manager.refreshAll(), /disposed/);
  });

  test('double dispose is safe', () => {
    manager.dispose();
    manager.dispose();
  });
});
