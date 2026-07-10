import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
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
    };
  }

  function diag(severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    return new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      'test',
      severity,
    );
  }

  test('fullScan seeds cache from all diagnostics', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileB, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);

    const changed = manager.fullScan();

    assert.strictEqual(changed.length, 2);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.get(fileB, folderUri)?.severity, ProblemSeverity.Warning);
  });

  test('fullScan skips files outside workspace', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileOutside, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);

    const changed = manager.fullScan();

    assert.strictEqual(changed.length, 0);
    assert.strictEqual(cache.get(fileOutside, folderUri), undefined);
  });

  test('processChanges updates cache for changed URIs', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);

    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
  });

  test('processChanges skips unchanged diagnostics', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);
    manager.fullScan();

    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 0);
  });

  test('processChanges detects severity change', () => {
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
    };
    const cache = new ProblemCache();
    const manager = new DiagnosticsManager(cache, delegate);
    manager.fullScan();

    currentDiagnostics = [diag(vscode.DiagnosticSeverity.Warning)];
    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Warning);
  });

  test('processChanges handles empty diagnostics (file fixed)', () => {
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
    };
    const cache = new ProblemCache();
    const manager = new DiagnosticsManager(cache, delegate);
    manager.fullScan();
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);

    currentDiagnostics = [];
    const event = { uris: [fileA] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.None);
  });

  test('getStatus returns cached status', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);
    manager.fullScan();

    const status = manager.getStatus(fileA);
    assert.strictEqual(status?.severity, ProblemSeverity.Error);
  });

  test('getStatus returns undefined for uncached file', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([]);
    const manager = new DiagnosticsManager(cache, delegate);

    const status = manager.getStatus(fileA);
    assert.strictEqual(status, undefined);
  });

  test('getStatus returns undefined for file outside workspace', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([]);
    const manager = new DiagnosticsManager(cache, delegate);

    const status = manager.getStatus(fileOutside);
    assert.strictEqual(status, undefined);
  });

  test('multiple files in processChanges', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileB, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);

    const event = { uris: [fileA, fileB] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 2);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.get(fileB, folderUri)?.severity, ProblemSeverity.Warning);
  });

  test('mixed workspace and non-workspace URIs', () => {
    const cache = new ProblemCache();
    const delegate = makeDelegate([
      [fileA, [diag(vscode.DiagnosticSeverity.Error)]],
      [fileOutside, [diag(vscode.DiagnosticSeverity.Warning)]],
    ]);
    const manager = new DiagnosticsManager(cache, delegate);

    const event = { uris: [fileA, fileOutside] };
    const changed = manager.processChanges(event);

    assert.strictEqual(changed.length, 1);
    assert.strictEqual(cache.get(fileA, folderUri)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.get(fileOutside, folderUri), undefined);
  });
});
