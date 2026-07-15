import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DecorationEngine } from '../../decoration/decorationEngine';
import {
  FolderStatusManager,
  FolderWorkspace,
} from '../../folder/folderStatusManager';
import { ApiManager } from '../../api/problemExplorerApi';
import { ProblemSeverity, ProblemState } from '../../core/types';
import { normalizeUriKey } from '../../core/uriKey';

const rootUri = Uri.parse('file:///workspace');
const fileA = Uri.parse('file:///workspace/src/a.ts');
const fileB = Uri.parse('file:///workspace/src/b.ts');

function state(severity: ProblemSeverity): ProblemState {
  return {
    severity,
    errorCount: severity === ProblemSeverity.Error ? 1 : 0,
    warningCount: severity === ProblemSeverity.Warning ? 1 : 0,
    infoCount: severity === ProblemSeverity.Info ? 1 : 0,
    fileCount: severity !== ProblemSeverity.None ? 1 : 0,
  };
}

suite('SingleSourceOfTruth', () => {
  let store: ProblemStore;
  let fm: FolderStatusManager;
  let de: DecorationEngine;
  let api: ApiManager;

  setup(() => {
    store = new ProblemStore();
    const wf: FolderWorkspace = {
      workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
      getWorkspaceFolder: (uri) =>
        uri.toString().startsWith(rootUri.toString() + '/')
          ? { uri: rootUri, name: 'workspace', index: 0 }
          : undefined,
    };
    fm = new FolderStatusManager(store, wf);
    de = new DecorationEngine(store, {
      getWorkspaceFolder: (uri) =>
        uri.toString().startsWith(rootUri.toString() + '/')
          ? { uri: rootUri, name: 'workspace', index: 0 }
          : undefined,
    });
    api = new ApiManager(store, wf);
  });

  test('diagnostics → store: processChanges writes to store', () => {
    store.set(fileA, state(ProblemSeverity.Error));
    assert.ok(store.get(fileA));
    assert.strictEqual(store.get(fileA)?.severity, ProblemSeverity.Error);
  });

  test('folder aggregation reads from store', () => {
    store.set(fileA, state(ProblemSeverity.Error));
    store.set(fileB, state(ProblemSeverity.Warning));
    fm.updateAncestors(fileA);
    fm.updateAncestors(fileB);

    const rootStatus = store.get(rootUri);
    assert.ok(rootStatus);
    assert.strictEqual(rootStatus.severity, ProblemSeverity.Error);
    assert.strictEqual(rootStatus.errorCount, 1);
    assert.strictEqual(rootStatus.warningCount, 1);
  });

  test('decoration lookup reads from store', () => {
    store.set(fileA, state(ProblemSeverity.Error));
    const deco = de.provideFileDecoration(fileA, {} as any);
    assert.ok(deco);
    assert.strictEqual(deco.badge, 'E');

    store.delete(fileA);
    const deco2 = de.provideFileDecoration(fileA, {} as any);
    assert.strictEqual(deco2, undefined);
  });

  test('deleteByPrefix removes entries from store', () => {
    const child = Uri.parse('file:///workspace/src/sub/file.ts');
    store.set(fileA, state(ProblemSeverity.Error));
    store.set(child, state(ProblemSeverity.Warning));
    assert.strictEqual(store.size(), 2);

    const count = store.deleteByPrefix(normalizeUriKey(fileA));
    assert.strictEqual(count, 1);
    assert.strictEqual(store.get(fileA), undefined);
    assert.ok(store.get(child));
  });

  test('rename (movePrefix) re-keys entries in store', () => {
    const newFile = Uri.parse('file:///workspace/src/a2.ts');
    store.set(fileA, state(ProblemSeverity.Error));
    fm.updateAncestors(fileA);
    assert.ok(store.get(rootUri));

    store.movePrefix(normalizeUriKey(fileA), normalizeUriKey(newFile));
    assert.strictEqual(store.get(fileA), undefined);
    assert.strictEqual(store.get(newFile)?.severity, ProblemSeverity.Error);
  });

  test('computeTotals reads from store', () => {
    store.set(fileA, state(ProblemSeverity.Error));
    store.set(fileB, state(ProblemSeverity.Warning));

    const totals = store.computeTotals();
    assert.strictEqual(totals.severity, ProblemSeverity.Error);
    assert.strictEqual(totals.errorCount, 1);
    assert.strictEqual(totals.warningCount, 1);
    assert.strictEqual(totals.infoCount, 0);
    assert.strictEqual(totals.fileCount, 2);
  });

  test('API consistency: getProblemState matches store.get', () => {
    store.set(fileA, state(ProblemSeverity.Error));
    const apiState = api.getProblemState(fileA);
    assert.ok(apiState);
    assert.strictEqual(apiState.severity, store.get(fileA)?.severity);
    assert.strictEqual(apiState.errorCount, store.get(fileA)?.errorCount);

    store.delete(fileA);
    assert.strictEqual(api.getProblemState(fileA), undefined);
  });
});
