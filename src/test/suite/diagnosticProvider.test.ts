import * as assert from 'assert';
import { Uri, EventEmitter } from 'vscode';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';

class MockDiagnosticProvider implements DiagnosticProvider {
  readonly name: string;
  readonly store: ProblemStore;
  readonly capabilities: import('../../core/types').ProviderCapabilities = { extensions: [] };
  readonly scanning = false;
  readonly autoScan = true;
  readonly enabled = true;
  readonly onDidProgressScan: import('vscode').Event<import('../../core/types').ScanProgress> = () => ({ dispose: () => {} });
  private _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;
  private _isRunning = false;
  private _isDisposed = false;
  private _initialized = false;

  constructor(name: string, store: ProblemStore) {
    this.name = name;
    this.store = store;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  async initialize(): Promise<void> {
    this.ensureNotDisposed();
    this._initialized = true;
  }

  start(): void {
    this.ensureNotDisposed();
    if (!this._initialized) {
      throw new Error('Must call initialize() before start()');
    }
    if (this._isRunning) return;
    this._isRunning = true;
  }

  stop(): void {
    this.ensureNotDisposed();
    if (!this._isRunning) return;
    this._isRunning = false;
  }

  refresh(): void {
    this.ensureNotDisposed();
    this._onDidUpdate.fire([]);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._isRunning = false;
    this._onDidUpdate.dispose();
  }

  private ensureNotDisposed(): void {
    if (this._isDisposed) {
      throw new Error('Provider is disposed');
    }
  }
}

suite('DiagnosticProvider (interface contract)', () => {
  let store: ProblemStore;
  let provider: MockDiagnosticProvider;

  setup(() => {
    store = new ProblemStore();
    provider = new MockDiagnosticProvider('testProvider', store);
  });

  test('satisfies DiagnosticProvider structural type', () => {
    const dp: DiagnosticProvider = provider;
    assert.strictEqual(dp.name, 'testProvider');
    assert.strictEqual(dp.store, store);
    assert.ok(typeof dp.onDidUpdate === 'function');
    assert.ok(typeof dp.initialize === 'function');
    assert.ok(typeof dp.start === 'function');
    assert.ok(typeof dp.stop === 'function');
    assert.ok(typeof dp.refresh === 'function');
    assert.ok(typeof dp.dispose === 'function');
  });

  test('initialize transitions to initialized state', async () => {
    assert.strictEqual(provider.initialized, false);
    await provider.initialize();
    assert.strictEqual(provider.initialized, true);
  });

  test('start requires initialize first', () => {
    assert.throws(() => provider.start(), /Must call initialize/);
  });

  test('lifecycle: initialize → start → stop → dispose', async () => {
    await provider.initialize();
    assert.strictEqual(provider.isRunning, false);

    provider.start();
    assert.strictEqual(provider.isRunning, true);

    provider.stop();
    assert.strictEqual(provider.isRunning, false);

    provider.dispose();
    assert.strictEqual(provider.isDisposed, true);
  });

  test('double start is safe', async () => {
    await provider.initialize();
    provider.start();
    provider.start();
    assert.strictEqual(provider.isRunning, true);
  });

  test('double stop is safe', async () => {
    await provider.initialize();
    provider.start();
    provider.stop();
    provider.stop();
    assert.strictEqual(provider.isRunning, false);
  });

  test('double dispose is safe', () => {
    provider.dispose();
    provider.dispose();
    assert.strictEqual(provider.isDisposed, true);
  });

  test('operations throw after dispose', async () => {
    provider.dispose();
    await assert.rejects(() => provider.initialize());
    assert.throws(() => provider.start(), /disposed/);
    assert.throws(() => provider.stop(), /disposed/);
    assert.throws(() => provider.refresh(), /disposed/);
  });

  test('onDidUpdate fires on refresh with changed URIs', () => {
    let fired = false;
    let received: Uri[] | undefined;
    provider.onDidUpdate((uris) => { fired = true; received = uris; });
    provider.refresh();
    assert.strictEqual(fired, true);
    assert.ok(Array.isArray(received));
  });

  test('onDidUpdate fires multiple times on multiple refreshes', () => {
    let count = 0;
    provider.onDidUpdate(() => { count++; });
    provider.refresh();
    provider.refresh();
    provider.refresh();
    assert.strictEqual(count, 3);
  });

  test('provider writes to ProblemStore', () => {
    const uri = Uri.parse('file:///workspace/src/test.ts');
    provider.store.set(uri, {
      severity: ProblemSeverity.Error,
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
      fileCount: 1,
    });
    assert.ok(provider.store.get(uri));
    assert.strictEqual(provider.store.get(uri)?.severity, ProblemSeverity.Error);
  });

  test('name is immutable', () => {
    assert.strictEqual(provider.name, 'testProvider');
  });

  test('unique provider names', () => {
    const p2 = new MockDiagnosticProvider('vsCodeDiagnostics', new ProblemStore());
    const p3 = new MockDiagnosticProvider('tscScanner', new ProblemStore());
    assert.notStrictEqual(p2.name, p3.name);
  });
});
