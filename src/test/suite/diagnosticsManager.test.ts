import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';
import { DiagnosticsManager, DiagnosticsDelegate } from '../../diagnostics/diagnosticsManager';

suite('DiagnosticsManager', () => {
  const folderUri = vscode.Uri.parse('file:///workspace/');
  const fileA = vscode.Uri.parse('file:///workspace/src/a.ts');
  const fileB = vscode.Uri.parse('file:///workspace/src/b.ts');
  const fileOutside = vscode.Uri.parse('file:///outside/file.ts');

  function makeDelegate(entries: [vscode.Uri, vscode.Diagnostic[]][]): DiagnosticsDelegate {
    const map = new Map(entries);
    return {
      getAllDiagnostics: () => entries,
      getUriDiagnostics: (uri: vscode.Uri) => map.get(uri) ?? [],
      getWorkspaceFolder: (uri: vscode.Uri) => {
        if (uri.toString().startsWith(folderUri.toString())) {
          return { uri: folderUri, name: 'workspace', index: 0 };
        }
        return undefined;
      },
      isActiveEditorUri: () => false,
    };
  }

  function diag(severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    return new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      'test',
      severity,
    );
  }

  function makeManager() {
    const cache = new ProblemCache();
    const store = new ProblemStore();
    const delegate = makeDelegate([]);
    const manager = new DiagnosticsManager(cache, store, delegate);
    return { cache, store, manager };
  }

  function makeManagerWithDelegate(delegate: DiagnosticsDelegate) {
    const cache = new ProblemCache();
    const store = new ProblemStore();
    const manager = new DiagnosticsManager(cache, store, delegate);
    return { cache, store, manager };
  }

  function assertIdentical(cache: ProblemCache, store: ProblemStore, uri: vscode.Uri, folderUri: vscode.Uri) {
    const cacheEntry = cache.get(uri, folderUri);
    const storeEntry = store.get(uri);
    assert.deepStrictEqual(storeEntry, cacheEntry, `store and cache differ for ${uri.toString()}`);
  }

  test('fullScan seeds both cache and store from all diagnostics', () => {
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileB, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    const { cache, store, manager } = makeManagerWithDelegate(delegate);

    const changed = manager.fullScan();

    assert.strictEqual(changed.length, 2);
    assertIdentical(cache, store, fileA, folderUri);
    assertIdentical(cache, store, fileB, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.get(fileB, folderUri)?.severity, ProblemSeverity.Warning);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileB)?.severity, ProblemSeverity.Warning);
  });

  test('fullScan skips files outside workspace', () => {
    const delegate = makeDelegate([
      [fileOutside, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const { cache, store, manager } = makeManagerWithDelegate(delegate);

    const changed = manager.fullScan();

    assert.strictEqual(changed.length, 0);
    assert.strictEqual(cache.get(fileOutside, folderUri), undefined);
    assert.strictEqual(store.get(fileOutside), undefined);
  });

  test('processChanges updates both cache and store for changed URIs', () => {
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const { cache, store, manager } = makeManagerWithDelegate(delegate);

    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assertIdentical(cache, store, fileA, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
  });

  test('processChanges skips unchanged diagnostics', () => {
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const { cache, store, manager } = makeManagerWithDelegate(delegate);
    manager.fullScan();

    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 0);
    assertIdentical(cache, store, fileA, folderUri);
  });

  test('processChanges detects severity change in both cache and store', () => {
    let currentDiagnostics: vscode.Diagnostic[] = [
      diag(vscode.DiagnosticSeverity.Error),
    ];
    const delegate: DiagnosticsDelegate = {
      getAllDiagnostics: () => [[fileA, currentDiagnostics]],
      getUriDiagnostics: () => currentDiagnostics,
      getWorkspaceFolder: (uri) =>
        uri.toString().startsWith(folderUri.toString())
          ? { uri: folderUri, name: 'workspace', index: 0 }
          : undefined,
      isActiveEditorUri: () => false,
    };
    const { cache, store, manager } = makeManagerWithDelegate(delegate);
    manager.fullScan();

    currentDiagnostics = [diag(vscode.DiagnosticSeverity.Warning)];
    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assertIdentical(cache, store, fileA, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Warning);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Warning);
  });

  test('processChanges handles empty diagnostics (file fixed) in both cache and store', () => {
    let currentDiagnostics: vscode.Diagnostic[] = [
      diag(vscode.DiagnosticSeverity.Error),
    ];
    const delegate: DiagnosticsDelegate = {
      getAllDiagnostics: () => [[fileA, currentDiagnostics]],
      getUriDiagnostics: () => currentDiagnostics,
      getWorkspaceFolder: (uri) =>
        uri.toString().startsWith(folderUri.toString())
          ? { uri: folderUri, name: 'workspace', index: 0 }
          : undefined,
      isActiveEditorUri: () => true, // Active editor so deletion happens
    };
    const { cache, store, manager } = makeManagerWithDelegate(delegate);
    manager.fullScan();
    assertIdentical(cache, store, fileA, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);

    currentDiagnostics = [];
    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assert.strictEqual(cache.get(fileA, folderUri), undefined);
    assert.strictEqual(store.get(fileA), undefined);
  });

  test('getStatus returns status from store', () => {
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const { store, manager } = makeManagerWithDelegate(delegate);
    manager.fullScan();

    const status = manager.getStatus(fileA);
    assert.strictEqual(status?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
  });

  test('getStatus returns undefined for uncached file', () => {
    const delegate = makeDelegate([]);
    const { manager } = makeManagerWithDelegate(delegate);

    const status = manager.getStatus(fileA);
    assert.strictEqual(status, undefined);
  });

  test('getStatus returns undefined for file outside workspace', () => {
    const delegate = makeDelegate([]);
    const { manager } = makeManagerWithDelegate(delegate);

    const status = manager.getStatus(fileOutside);
    assert.strictEqual(status, undefined);
  });

  test('multiple files in processChanges updates both cache and store', () => {
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileB, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    const { cache, store, manager } = makeManagerWithDelegate(delegate);

    const event = { uris: [fileA, fileB] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 2);
    assertIdentical(cache, store, fileA, folderUri);
    assertIdentical(cache, store, fileB, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.get(fileB, folderUri)?.severity, ProblemSeverity.Warning);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileB)?.severity, ProblemSeverity.Warning);
  });

  test('mixed workspace and non-workspace URIs updates both identically', () => {
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileOutside, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    const { cache, store, manager } = makeManagerWithDelegate(delegate);

    const event = { uris: [fileA, fileOutside] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assertIdentical(cache, store, fileA, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.get(fileOutside, folderUri), undefined);
    assert.strictEqual(store.get(fileOutside), undefined);
  });
});