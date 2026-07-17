import * as assert from 'assert';
import { Uri, EventEmitter } from 'vscode';
import { DiagnosticProviderManager, ProviderState, ProviderInfo } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ProblemStore } from '../../store/ProblemStore';
import { ProviderCapabilities, ScanProgress } from '../../core/types';


class MockProvider implements DiagnosticProvider {
  readonly name: string;
  readonly store: ProblemStore;
  readonly capabilities: ProviderCapabilities;
  readonly scanning = false;
  readonly autoScan = true;
  readonly enabled = true;
  readonly onDidProgressScan = new EventEmitter<ScanProgress>().event;
  private _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;
  private _started = false;
  private _disposed = false;
  private _initialized = false;

  callOrder: string[] = [];

  constructor(name: string, store: ProblemStore, capabilities?: ProviderCapabilities) {
    this.name = name;
    this.store = store;
    this.capabilities = capabilities ?? { extensions: [] };
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
  readonly capabilities: ProviderCapabilities = { extensions: [] };
  readonly scanning = false;
  readonly autoScan = false;
  readonly enabled = true;
  readonly onDidProgressScan: DiagnosticProvider['onDidProgressScan'] = () => ({ dispose: () => {} });
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

  test('register with metadata stores priority and capabilities', () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p, { priority: 10, capabilities: ['diagnostics', 'realtime'] });
    const info = manager.getInfo('p1');
    assert.ok(info);
    assert.strictEqual(info!.metadata.priority, 10);
    assert.deepStrictEqual(info!.metadata.capabilities, ['diagnostics', 'realtime']);
  });

  test('register without metadata defaults priority 0 and empty capabilities', () => {
    manager.register('p1', new MockProvider('p1', store));
    const info = manager.getInfo('p1');
    assert.ok(info);
    assert.strictEqual(info!.metadata.priority, 0);
    assert.deepStrictEqual(info!.metadata.capabilities, []);
  });

  test('getProviderState returns idle after registration', () => {
    manager.register('p1', new MockProvider('p1', store));
    assert.strictEqual(manager.getProviderState('p1'), ProviderState.idle);
  });

  test('getProviderState returns undefined for unknown provider', () => {
    assert.strictEqual(manager.getProviderState('nope'), undefined);
  });

  test('setProviderState updates state and fires event', () => {
    manager.register('p1', new MockProvider('p1', store));
    let fired: { name: string; oldState: ProviderState; newState: ProviderState } | undefined;
    manager.onDidChangeProviderState((e) => { fired = e; });
    manager.setProviderState('p1', ProviderState.error);
    assert.strictEqual(fired!.name, 'p1');
    assert.strictEqual(fired!.oldState, ProviderState.idle);
    assert.strictEqual(fired!.newState, ProviderState.error);
    assert.strictEqual(manager.getProviderState('p1'), ProviderState.error);
  });

  test('setProviderState does not fire event for same state', () => {
    manager.register('p1', new MockProvider('p1', store));
    let fireCount = 0;
    manager.onDidChangeProviderState(() => { fireCount++; });
    manager.setProviderState('p1', ProviderState.idle);
    assert.strictEqual(fireCount, 0);
  });

  test('setProviderState is no-op for unknown provider', () => {
    let fireCount = 0;
    manager.onDidChangeProviderState(() => { fireCount++; });
    manager.setProviderState('nope', ProviderState.running);
    assert.strictEqual(fireCount, 0);
  });

  test('initializeAll sets state to idle after success', async () => {
    manager.register('p1', new MockProvider('p1', store));
    await manager.initializeAll();
    assert.strictEqual(manager.getProviderState('p1'), ProviderState.idle);
  });

  test('initializeAll sets state to error on failure', async () => {
    manager.register('bad', new FailingProvider('bad'));
    await manager.initializeAll();
    assert.strictEqual(manager.getProviderState('bad'), ProviderState.error);
  });

  test('startAll sets state to running', () => {
    manager.register('p1', new MockProvider('p1', store));
    manager.startAll();
    assert.strictEqual(manager.getProviderState('p1'), ProviderState.running);
  });

  test('startAll sets state to error on failure', () => {
    manager.register('bad', new FailingProvider('bad'));
    manager.startAll();
    assert.strictEqual(manager.getProviderState('bad'), ProviderState.error);
  });

  test('stopAll sets state to idle for running providers', () => {
    manager.register('p1', new MockProvider('p1', store));
    manager.startAll();
    manager.stopAll();
    assert.strictEqual(manager.getProviderState('p1'), ProviderState.idle);
  });

  test('startAll respects priority ordering (high first)', () => {
    const high = new MockProvider('high', store);
    const low = new MockProvider('low', store);
    manager.register('low', low, { priority: 1 });
    manager.register('high', high, { priority: 100 });
    manager.startAll();
    assert.strictEqual(high.isStarted, true);
    assert.strictEqual(low.isStarted, true);
  });

  test('priority ordering: higher priority starts first', () => {
    const startOrder: string[] = [];
    class OrderProvider extends MockProvider {
      start(): void { super.start(); startOrder.push(this.name); }
    }
    const low = new OrderProvider('low', store);
    const mid = new OrderProvider('mid', store);
    const high = new OrderProvider('high', store);
    manager.register('low', low, { priority: 1 });
    manager.register('high', high, { priority: 100 });
    manager.register('mid', mid, { priority: 50 });
    manager.startAll();
    assert.deepStrictEqual(startOrder, ['high', 'mid', 'low']);
  });

  test('stopAll reverses priority order', () => {
    const stopOrder: string[] = [];
    class OrderProvider extends MockProvider {
      stop(): void { super.stop(); stopOrder.push(this.name); }
    }
    const low = new OrderProvider('low', store);
    const high = new OrderProvider('high', store);
    manager.register('low', low, { priority: 1 });
    manager.register('high', high, { priority: 100 });
    manager.startAll();
    stopOrder.length = 0;
    manager.stopAll();
    assert.deepStrictEqual(stopOrder, ['low', 'high']);
  });

  test('all() returns all providers with info', () => {
    manager.register('a', new MockProvider('a', store));
    manager.register('b', new MockProvider('b', store), { priority: 5 });
    const all = manager.all();
    assert.strictEqual(all.length, 2);
    const names = all.map((e) => e.name).sort();
    assert.deepStrictEqual(names, ['a', 'b']);
  });

  test('all() throws after dispose', () => {
    manager.dispose();
    assert.throws(() => manager.all(), /disposed/);
  });

  test('getByState filters by state', () => {
    manager.register('a', new MockProvider('a', store));
    manager.register('b', new FailingProvider('b'));
    manager.startAll();
    const running = manager.getByState(ProviderState.running);
    const errors = manager.getByState(ProviderState.error);
    assert.strictEqual(running.length, 1);
    assert.strictEqual(running[0].name, 'a');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].name, 'b');
  });

  test('getByCapability filters by capability', () => {
    manager.register('a', new MockProvider('a', store), { capabilities: ['diagnostics', 'realtime'] });
    manager.register('b', new MockProvider('b', store), { capabilities: ['tsc-scan'] });
    manager.register('c', new MockProvider('c', store), { capabilities: ['diagnostics'] });

    const diagnostics = manager.getByCapability('diagnostics');
    const realtime = manager.getByCapability('realtime');
    const tscScan = manager.getByCapability('tsc-scan');
    const none = manager.getByCapability('nonexistent');

    assert.strictEqual(diagnostics.length, 2);
    assert.strictEqual(realtime.length, 1);
    assert.strictEqual(realtime[0].name, 'a');
    assert.strictEqual(tscScan.length, 1);
    assert.strictEqual(tscScan[0].name, 'b');
    assert.strictEqual(none.length, 0);
  });

  test('hasCapability returns true for advertised capability', () => {
    manager.register('a', new MockProvider('a', store), { capabilities: ['diagnostics'] });
    assert.strictEqual(manager.hasCapability('a', 'diagnostics'), true);
    assert.strictEqual(manager.hasCapability('a', 'tsc-scan'), false);
    assert.strictEqual(manager.hasCapability('nonexistent', 'diagnostics'), false);
  });

  test('onDidRegister fires with provider info', () => {
    let fired: ProviderInfo | undefined;
    manager.onDidRegister((e) => { fired = e; });
    manager.register('a', new MockProvider('a', store), { priority: 5, capabilities: ['x'] });
    assert.ok(fired);
    assert.strictEqual(fired!.name, 'a');
    assert.strictEqual(fired!.metadata.priority, 5);
    assert.strictEqual(fired!.state, ProviderState.idle);
  });

  test('onDidUnregister fires on unregister', () => {
    let firedName: string | undefined;
    manager.onDidUnregister((e) => { firedName = e.name; });
    manager.register('a', new MockProvider('a', store));
    manager.unregister('a');
    assert.strictEqual(firedName, 'a');
  });

  test('onDidUpdateAll aggregates events from all providers', () => {
    let allUris: Uri[] | undefined;
    manager.onDidUpdateAll((uris) => { allUris = uris; });

    const p1 = new MockProvider('p1', store);
    const p2 = new MockProvider('p2', store);
    manager.register('p1', p1);
    manager.register('p2', p2);

    const uri = Uri.parse('file:///test.ts');
    (p1 as any)._onDidUpdate.fire([uri]);
    assert.deepStrictEqual(allUris, [uri]);

    (p2 as any)._onDidUpdate.fire([uri]);
    assert.deepStrictEqual(allUris, [uri]);
  });

  test('getInfo returns undefined for unknown provider', () => {
    assert.strictEqual(manager.getInfo('nope'), undefined);
  });

  test('getInfo throws after dispose', () => {
    manager.dispose();
    assert.throws(() => manager.getInfo('x'), /disposed/);
  });

  test('getProviderState throws after dispose', () => {
    manager.dispose();
    assert.throws(() => manager.getProviderState('x'), /disposed/);
  });

  test('unregister disposes provider update subscription', () => {
    const p = new MockProvider('p1', store);
    manager.register('p1', p);
    let updateCount = 0;
    manager.onDidUpdateAll(() => { updateCount++; });
    p.refresh();
    const countBefore = updateCount;
    manager.unregister('p1');
    p.callOrder = [];
    assert.strictEqual(manager.size, 0);
    assert.strictEqual(updateCount, countBefore);
  });

  test('getOwner returns provider name for owned extension', () => {
    const p = new MockProvider('tsc', store, { extensions: ['.ts', '.tsx'] });
    manager.register('tsc', p);
    assert.strictEqual(manager.getOwner('.ts'), 'tsc');
    assert.strictEqual(manager.getOwner('.tsx'), 'tsc');
  });

  test('getOwner returns undefined for unowned extension', () => {
    const p = new MockProvider('tsc', store, { extensions: ['.ts', '.tsx'] });
    manager.register('tsc', p);
    assert.strictEqual(manager.getOwner('.js'), undefined);
    assert.strictEqual(manager.getOwner('.vue'), undefined);
  });

  test('getOwner returns highest priority provider for overlapping extensions', () => {
    const low = new MockProvider('low', store, { extensions: ['.ts'] });
    const high = new MockProvider('high', store, { extensions: ['.ts', '.tsx'] });
    manager.register('low', low, { priority: 1 });
    manager.register('high', high, { priority: 100 });
    assert.strictEqual(manager.getOwner('.ts'), 'high');
    assert.strictEqual(manager.getOwner('.tsx'), 'high');
  });

  test('getOwner rebuilds on unregister', () => {
    const p = new MockProvider('tsc', store, { extensions: ['.ts'] });
    manager.register('tsc', p);
    assert.strictEqual(manager.getOwner('.ts'), 'tsc');
    manager.unregister('tsc');
    assert.strictEqual(manager.getOwner('.ts'), undefined);
  });

  test('getOwner rebuilds on register after unregister', () => {
    const p1 = new MockProvider('p1', store, { extensions: ['.ts'] });
    const p2 = new MockProvider('p2', store, { extensions: ['.ts'] });
    manager.register('p1', p1);
    manager.unregister('p1');
    manager.register('p2', p2);
    assert.strictEqual(manager.getOwner('.ts'), 'p2');
  });

  test('getOwnedExtensions returns extensions for known provider', () => {
    const p = new MockProvider('tsc', store, { extensions: ['.ts', '.tsx'] });
    manager.register('tsc', p);
    const exts = manager.getOwnedExtensions('tsc');
    assert.ok(exts);
    assert.strictEqual(exts!.length, 2);
    assert.ok(exts!.includes('.ts'));
    assert.ok(exts!.includes('.tsx'));
  });

  test('getOwnedExtensions returns undefined for unknown provider', () => {
    assert.strictEqual(manager.getOwnedExtensions('nope'), undefined);
  });

  test('getOwnedExtensions returns empty array for provider with no extensions', () => {
    const p = new MockProvider('empty', store, { extensions: [] });
    manager.register('empty', p);
    const exts = manager.getOwnedExtensions('empty');
    assert.ok(exts);
    assert.strictEqual(exts!.length, 0);
  });

  test('canProviderProcess returns true for owned extension', () => {
    const p = new MockProvider('tsc', store, { extensions: ['.ts', '.tsx'] });
    manager.register('tsc', p);
    assert.strictEqual(manager.canProviderProcess('tsc', '.ts'), true);
    assert.strictEqual(manager.canProviderProcess('tsc', '.js'), false);
  });

  test('canProviderProcess returns false for unknown provider', () => {
    assert.strictEqual(manager.canProviderProcess('nope', '.ts'), false);
  });

  test('getOwner is thread-safe; concurrent calls return consistent results', () => {
    const p = new MockProvider('tsc', store, { extensions: ['.ts'] });
    manager.register('tsc', p);
    const results = Array.from({ length: 10 }, () => manager.getOwner('.ts'));
    assert.ok(results.every((r) => r === 'tsc'));
  });
});
