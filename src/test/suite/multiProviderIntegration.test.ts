import * as assert from 'assert';
import * as vscode from 'vscode';
import { Uri, Diagnostic, EventEmitter } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { VSCodeDiagnosticProvider } from '../../providers/VSCodeDiagnosticProvider';
import { DiagnosticsDelegate } from '../../diagnostics/diagnosticsManager';
import { DecorationEngine } from '../../decoration/decorationEngine';

const rootUri = Uri.parse('file:///workspace');
const fileA = Uri.parse('file:///workspace/src/a.ts');
const fileB = Uri.parse('file:///workspace/src/b.ts');
const fileC = Uri.parse('file:///workspace/src/c.ts');

function diag(severity: vscode.DiagnosticSeverity): Diagnostic {
  return new Diagnostic(new vscode.Range(0, 0, 0, 1), 'test', severity);
}

function workspaceFolderDelegate() {
  return {
    getWorkspaceFolder: (uri: Uri) =>
      uri.toString().startsWith(rootUri.toString() + '/')
        ? { uri: rootUri, name: 'workspace', index: 0 }
        : undefined,
  };
}

function makeVsCodeDelegate(
  entries: [Uri, Diagnostic[]][],
): DiagnosticsDelegate {
  const map = new Map(entries);
  return {
    getAllDiagnostics: () => entries,
    getUriDiagnostics: (uri: Uri) => map.get(uri) ?? [],
    getWorkspaceFolder: (uri: Uri) => {
      if (uri.toString().startsWith(rootUri.toString())) {
        return { uri: rootUri, name: 'workspace', index: 0 };
      }
      return undefined;
    },
    isActiveEditorUri: () => false,
  };
}

class DummyProvider implements DiagnosticProvider {
  readonly name: string;
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;
  private _disposed = false;

  get store(): ProblemStore {
    return this._store;
  }

  constructor(name: string, store: ProblemStore) {
    this.name = name;
    this._store = store;
  }

  initialize(): void {
    if (this._disposed) return;
    this._store.set(fileA, {
      severity: ProblemSeverity.Info,
      errorCount: 0,
      warningCount: 0,
      infoCount: 1,
      fileCount: 1,
    });
    this._store.set(fileB, {
      severity: ProblemSeverity.Info,
      errorCount: 0,
      warningCount: 0,
      infoCount: 1,
      fileCount: 1,
    });
  }

  start(): void {
    if (this._disposed) return;
  }

  stop(): void {
    if (this._disposed) return;
  }

  refresh(): void {
    if (this._disposed) return;
    this._store.set(fileC, {
      severity: ProblemSeverity.Info,
      errorCount: 0,
      warningCount: 0,
      infoCount: 1,
      fileCount: 1,
    });
    this._onDidUpdate.fire([fileC]);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._onDidUpdate.dispose();
  }
}

class FailingProvider implements DiagnosticProvider {
  readonly name = 'failing';
  readonly store: ProblemStore;
  readonly onDidUpdate: vscode.Event<Uri[]>;
  private _emitter = new EventEmitter<Uri[]>();
  private _disposed = false;

  constructor(store: ProblemStore) {
    this.store = store;
    this.onDidUpdate = this._emitter.event;
  }

  initialize(): void | Promise<void> {
    throw new Error('init failure');
  }
  start(): void {
    throw new Error('start failure');
  }
  stop(): void {
    throw new Error('stop failure');
  }
  refresh(): void {
    throw new Error('refresh failure');
  }
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._emitter.dispose();
  }
}

suite('MultiProviderIntegration', () => {
  let store: ProblemStore;
  let manager: DiagnosticProviderManager;
  let vsDiagProvider: VSCodeDiagnosticProvider;
  let dummyProvider: DummyProvider;

  setup(() => {
    store = new ProblemStore();
    manager = new DiagnosticProviderManager();
  });

  teardown(() => {
    manager.dispose();
  });

  test('Scenario 1: VSCodeDiagnosticProvider produces diagnostics, DecorationEngine updates', () => {
    const delegate = makeVsCodeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileB, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    vsDiagProvider = new VSCodeDiagnosticProvider(store, delegate);
    manager.register('vscode', vsDiagProvider);

    vsDiagProvider.fullScan();

    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileB)?.severity, ProblemSeverity.Warning);

    const decorationEngine = new DecorationEngine(store, workspaceFolderDelegate());
    decorationEngine.refresh();

    const totals = store.computeTotals();
    assert.strictEqual(totals.errorCount, 1);
    assert.strictEqual(totals.warningCount, 1);
    assert.strictEqual(totals.fileCount, 2);
  });

  test('Scenario 2: Two providers write into ProblemStore without conflicts', () => {
    vsDiagProvider = new VSCodeDiagnosticProvider(store, makeVsCodeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]));
    dummyProvider = new DummyProvider('dummy', store);
    manager.register('vscode', vsDiagProvider);
    manager.register('dummy', dummyProvider);

    vsDiagProvider.fullScan();
    dummyProvider.initialize();

    assert.strictEqual(store.size, 3);
    const stateA = store.get(fileA);
    assert.strictEqual(stateA?.severity, ProblemSeverity.Error);
    assert.strictEqual(stateA?.errorCount, 1);
    const stateFileBDummy = store.get(fileB);
    assert.strictEqual(stateFileBDummy?.severity, ProblemSeverity.Info);
    assert.strictEqual(stateFileBDummy?.infoCount, 1);
  });

  test('Scenario 3: Failing provider does not prevent manager from running', async () => {
    const goodProvider = new DummyProvider('good', store);
    manager.register('good', goodProvider);
    manager.register('failing', new FailingProvider(store));

    await manager.initializeAll();
    manager.startAll();

    assert.strictEqual(manager.started, true);
    assert.strictEqual(manager.size, 2);

    const goodState = store.get(fileA);
    assert.ok(goodState, 'good provider wrote data despite failing provider');
    assert.strictEqual(goodState.severity, ProblemSeverity.Info);

    manager.refreshAll();
    assert.strictEqual(manager.started, true);

    manager.stopAll();
    assert.strictEqual(manager.started, false);
  });

  test('Scenario 4: Provider stop/start maintains state consistency', () => {
    const delegate = makeVsCodeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    vsDiagProvider = new VSCodeDiagnosticProvider(store, delegate);
    manager.register('vscode', vsDiagProvider);
    manager.startAll();

    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);

    manager.stopAll();
    assert.strictEqual(manager.started, false);

    const stateAfterStop = store.get(fileA);
    assert.strictEqual(stateAfterStop?.severity, ProblemSeverity.Error);

    manager.startAll();
    assert.strictEqual(manager.started, true);

    const stateAfterRestart = store.get(fileA);
    assert.strictEqual(stateAfterRestart?.severity, ProblemSeverity.Error);
  });

  test('Scenario 5: Provider disposal releases resources correctly', () => {
    let onDidUpdateCalled = false;
    const disposableProvider = new DummyProvider('disp', store);
    disposableProvider.onDidUpdate(() => {
      onDidUpdateCalled = true;
    });
    manager.register('disp', disposableProvider);
    manager.startAll();

    disposableProvider.refresh();
    assert.strictEqual(onDidUpdateCalled, true);

    manager.dispose();

    assert.strictEqual(manager.disposed, true);
    assert.strictEqual(manager.size, 0);

    assert.throws(() => manager.register('x', disposableProvider), /disposed/);
  });
});
