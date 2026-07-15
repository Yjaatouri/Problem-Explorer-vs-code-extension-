import * as assert from 'assert';
import { Uri, EventEmitter } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ProblemStore } from '../../store/ProblemStore';


class MockProvider implements DiagnosticProvider {
  readonly name: string;
  readonly store: ProblemStore;
  private _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;
  private _started = false;
  private _disposed = false;
  private _initialized = false;

  callOrder: string[] = [];

  constructor(name: string, store: ProblemStore) {
    this.name = name;
    this.store = store;
  }

  get isStarted(): boolean { return this._started; }
  get isDisposed(): boolean { return this._disposed; }
  get isInitialized(): boolean { return this._initialized; }

  async initialize(): Promise<void> {
    if (this._disposed) throw new Error('disposed');
    this._initialized = true;
    this.callOrder.push('initialize');
  }

  start(): void {
    if (this._disposed) throw new Error('disposed');
    this._started = true;
    this.callOrder.push('start');
  }

  stop(): void {
    if (this._disposed) throw new Error('disposed');
    this._started = false;
    this.callOrder.push('stop');
  }

  refresh(): void {
    if (this._disposed) throw new Error('disposed');
    this._onDidUpdate.fire([]);
    this.callOrder.push('refresh');
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._started = false;
    this._onDidUpdate.dispose();
    this.callOrder.push('dispose');
  }
}

class FailingProvider implements DiagnosticProvider {
  readonly name: string;
  readonly store = new ProblemStore();
  private _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;

  constructor(name: string) { this.name = name; }

  async initialize(): Promise<void> { throw new Error('init fail'); }
  start(): void { throw new Error('start fail'); }
  stop(): void { throw new Error('stop fail'); }
  refresh(): void { throw new Error('refresh fail'); }
  dispose(): void { throw new Error('dispose fail'); }
}

suite('DiagnosticProviderManager', () => {
  let manager: DiagnosticProviderManager;
  let store: ProblemStore;

  setup(() => {
    manager = new DiagnosticProviderManager();
    store = new ProblemStore();
  });

  test('register adds a provider', () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p);
    assert.strictEqual(manager.size, 1);
    assert.strictEqual(manager.get('p1'), p);
  });

  test('duplicate registration throws', () => {
    manager.register('p1', new MockProvider('p1', store));
    assert.throws(() => manager.register('p1', new MockProvider('p1', store)), /already registered/);
  });

  test('register with different names succeeds', () => {
    manager.register('a', new MockProvider('a', store));
    manager.register('b', new MockProvider('b', store));
    assert.strictEqual(manager.size, 2);
  });

  test('unregister removes a provider and disposes it', () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p);
    const result = manager.unregister('p1');
    assert.strictEqual(result, true);
    assert.strictEqual(manager.size, 0);
    assert.strictEqual(manager.get('p1'), undefined);
    assert.strictEqual(p.isDisposed, true);
  });

  test('unregister nonexistent returns false', () => {
    assert.strictEqual(manager.unregister('nonexistent'), false);
  });

  test('unregister stops started provider before disposing', async () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p);
    manager.startAll();
    assert.strictEqual(p.isStarted, true);

    manager.unregister('p1');
    assert.strictEqual(p.isStarted, false);
    assert.strictEqual(p.callOrder.slice(-2).join(','), 'stop,dispose');
  });

  test('get returns undefined for unknown name', () => {
    assert.strictEqual(manager.get('nonexistent'), undefined);
  });

  test('started is false initially', () => {
    assert.strictEqual(manager.started, false);
  });

  test('started is true after startAll', () => {
    manager.register('p1', new MockProvider('p1', store));
    manager.startAll();
    assert.strictEqual(manager.started, true);
  });

  test('started is false after stopAll', () => {
    manager.register('p1', new MockProvider('p1', store));
    manager.startAll();
    manager.stopAll();
    assert.strictEqual(manager.started, false);
  });

  test('startAll starts all registered providers', () => {
    const p1 = new MockProvider('p1', store);
    const p2 = new MockProvider('p2', store);
    manager.register('p1', p1);
    manager.register('p2', p2);

    manager.startAll();

    assert.strictEqual(p1.isStarted, true);
    assert.strictEqual(p2.isStarted, true);
    assert.deepStrictEqual(p1.callOrder, ['start']);
    assert.deepStrictEqual(p2.callOrder, ['start']);
  });

  test('stopAll stops all providers', () => {
    const p1 = new MockProvider('p1', store);
    const p2 = new MockProvider('p2', store);
    manager.register('p1', p1);
    manager.register('p2', p2);
    manager.startAll();
    p1.callOrder = [];
    p2.callOrder = [];

    manager.stopAll();

    assert.strictEqual(p1.isStarted, false);
    assert.strictEqual(p2.isStarted, false);
    assert.deepStrictEqual(p1.callOrder, ['stop']);
    assert.deepStrictEqual(p2.callOrder, ['stop']);
  });

  test('stopAll is safe when not started', () => {
    manager.register('p1', new MockProvider('p1', store));
    manager.stopAll();
    assert.strictEqual(manager.started, false);
  });

  test('refreshAll refreshes all providers', () => {
    const p1 = new MockProvider('p1', store);
    const p2 = new MockProvider('p2', store);
    manager.register('p1', p1);
    manager.register('p2', p2);

    manager.refreshAll();

    assert.deepStrictEqual(p1.callOrder, ['refresh']);
    assert.deepStrictEqual(p2.callOrder, ['refresh']);
  });

  test('initializeAll initializes all providers', async () => {
    const p1 = new MockProvider('p1', store);
    const p2 = new MockProvider('p2', store);
    manager.register('p1', p1);
    manager.register('p2', p2);

    await manager.initializeAll();

    assert.strictEqual(p1.isInitialized, true);
    assert.strictEqual(p2.isInitialized, true);
    assert.deepStrictEqual(p1.callOrder, ['initialize']);
  });

  test('full lifecycle: initialize → start → stop → dispose', async () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p);

    await manager.initializeAll();
    assert.strictEqual(p.isInitialized, true);
    assert.strictEqual(manager.started, false);

    manager.startAll();
    assert.strictEqual(p.isStarted, true);
    assert.strictEqual(manager.started, true);

    manager.stopAll();
    assert.strictEqual(p.isStarted, false);
    assert.strictEqual(manager.started, false);

    manager.dispose();
    assert.strictEqual(p.isDisposed, true);
    assert.strictEqual(manager.disposed, true);
    assert.strictEqual(manager.size, 0);
  });

  test('dispose disposes all providers', () => {
    const p1 = new MockProvider('p1', store);
    const p2 = new MockProvider('p2', store);
    manager.register('p1', p1);
    manager.register('p2', p2);

    manager.dispose();

    assert.strictEqual(p1.isDisposed, true);
    assert.strictEqual(p2.isDisposed, true);
    assert.strictEqual(manager.size, 0);
  });

  test('double dispose is safe', () => {
    manager.dispose();
    manager.dispose();
    assert.strictEqual(manager.disposed, true);
  });

  test('operations after dispose throw', () => {
    manager.dispose();
    assert.throws(() => manager.register('x', new MockProvider('x', store)), /disposed/);
    assert.throws(() => manager.unregister('x'), /disposed/);
    assert.throws(() => manager.startAll(), /disposed/);
    assert.throws(() => manager.stopAll(), /disposed/);
    assert.throws(() => manager.refreshAll(), /disposed/);
    assert.throws(() => manager.get('x'), undefined);
  });

  test('failing provider does not prevent others from starting', () => {
    const good = new MockProvider('good', store);
    manager.register('good', good);
    manager.register('bad', new FailingProvider('bad'));

    manager.startAll();

    assert.strictEqual(good.isStarted, true);
    assert.strictEqual(manager.started, true);
  });

  test('failing provider does not prevent others from stopping', () => {
    const good = new MockProvider('good', store);
    manager.register('good', good);
    manager.register('bad', new FailingProvider('bad'));
    manager.startAll();

    manager.stopAll();

    assert.strictEqual(good.isStarted, false);
    assert.strictEqual(manager.started, false);
  });

  test('failing provider does not prevent others from refreshing', () => {
    const good = new MockProvider('good', store);
    manager.register('good', good);
    manager.register('bad', new FailingProvider('bad'));

    manager.refreshAll();

    assert.deepStrictEqual(good.callOrder, ['refresh']);
  });

  test('failing provider does not prevent others from initializing', async () => {
    const good = new MockProvider('good', store);
    manager.register('good', good);
    manager.register('bad', new FailingProvider('bad'));

    await manager.initializeAll();

    assert.strictEqual(good.isInitialized, true);
  });

  test('failing provider does not prevent dispose of others', () => {
    const good = new MockProvider('good', store);
    manager.register('good', good);
    manager.register('bad', new FailingProvider('bad'));

    manager.dispose();

    assert.strictEqual(good.isDisposed, true);
    assert.strictEqual(manager.disposed, true);
  });

  test('dispose stops started providers before clearing', () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p);
    manager.startAll();
    assert.strictEqual(p.isStarted, true);

    manager.dispose();

    assert.strictEqual(p.isDisposed, true);
    assert.strictEqual(manager.size, 0);
  });
});
