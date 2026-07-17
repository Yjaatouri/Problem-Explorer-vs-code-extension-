import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { ProblemSeverity, ProblemState } from '../../core/types';

function makeState(errorCount: number, warningCount = 0): ProblemState {
  return {
    severity: errorCount > 0 ? ProblemSeverity.Error : ProblemSeverity.Warning,
    errorCount,
    warningCount,
    infoCount: 0,
    fileCount: 1,
  };
}

suite('Large Workspace Performance', () => {
  let store: ProblemStore;

  setup(() => {
    store = new ProblemStore();
  });

  teardown(() => {
    store.dispose();
  });

  test('insert 10,000 files with ownership (batched)', () => {
    store.configureProvider('test', 100);
    const uris: Uri[] = [];
    for (let i = 0; i < 10000; i++) {
      uris.push(Uri.parse(`file:///project/src/${Math.floor(i / 100)}/file${i}.ts`));
    }

    store.beginBatch();
    const insertStart = performance.now();
    for (let i = 0; i < uris.length; i++) {
      store.set(uris[i], makeState(i % 3 === 0 ? 1 : 0, i % 5 === 0 ? 1 : 0), 'test');
    }
    store.endBatch();
    const insertElapsed = performance.now() - insertStart;

    assert.strictEqual(store.size(), 10000);
    assert.ok(insertElapsed < 5000, `insert 10k took ${insertElapsed.toFixed(0)}ms (expected <5000ms)`);
  });

  test('computeTotals with 10,000 files (O(1) path)', () => {
    store.configureProvider('test', 100);
    for (let i = 0; i < 10000; i++) {
      store.set(
        Uri.parse(`file:///project/src/file${i}.ts`),
        makeState(i < 3000 ? 1 : 0, i < 5000 ? 1 : 0),
        'test',
      );
    }

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      store.computeTotals();
    }
    const elapsed = performance.now() - start;

    const totals = store.computeTotals();
    assert.strictEqual(totals.errorCount, 3000);
    assert.strictEqual(totals.warningCount, 5000);
    assert.strictEqual(totals.fileCount, 10000);
    assert.ok(elapsed < 100, `1000x computeTotals took ${elapsed.toFixed(1)}ms (expected <100ms)`);
  });

  test('deleteByPrefix with 10,000 files', () => {
    store.configureProvider('test', 100);
    for (let i = 0; i < 10000; i++) {
      store.set(
        Uri.parse(`file:///project/src/sub${Math.floor(i / 1000)}/file${i}.ts`),
        makeState(1),
        'test',
      );
    }

    const start = performance.now();
    const count = store.deleteByPrefix('file:///project/src/sub0');
    const elapsed = performance.now() - start;

    assert.strictEqual(count, 1000);
    assert.strictEqual(store.size(), 9000);
    assert.ok(elapsed < 500, `deleteByPrefix(1000 entries) took ${elapsed.toFixed(0)}ms (expected <500ms)`);
  });

  test('movePrefix with 10,000 files', () => {
    store.configureProvider('test', 100);
    for (let i = 0; i < 10000; i++) {
      store.set(
        Uri.parse(`file:///project/src/old/file${i}.ts`),
        makeState(1),
        'test',
      );
    }

    const start = performance.now();
    const count = store.movePrefix('file:///project/src/old', 'file:///project/src/new');
    const elapsed = performance.now() - start;

    assert.strictEqual(count, 10000);
    assert.strictEqual(store.has(Uri.parse('file:///project/src/old/file0.ts')), false);
    assert.strictEqual(store.has(Uri.parse('file:///project/src/new/file0.ts')), true);
    assert.ok(elapsed < 500, `movePrefix(10000 entries) took ${elapsed.toFixed(0)}ms (expected <500ms)`);
  });

  test('forEachFileEntry with 10,000 entries (no snapshot overhead)', () => {
    store.configureProvider('test', 100);
    for (let i = 0; i < 10000; i++) {
      store.set(Uri.parse(`file:///project/src/file${i}.ts`), makeState(1), 'test');
    }

    let count = 0;
    const start = performance.now();
    store.forEachFileEntry((_key, _state) => {
      count++;
    });
    const elapsed = performance.now() - start;

    assert.strictEqual(count, 10000);
    assert.ok(elapsed < 200, `forEachFileEntry(10000) took ${elapsed.toFixed(0)}ms (expected <200ms)`);
  });
});

suite('Large Workspace - Folder Aggregation', () => {
  let store: ProblemStore;
  let fsm: FolderStatusManager;

  setup(() => {
    store = new ProblemStore();
    fsm = new FolderStatusManager(store);
  });

  teardown(() => {
    store.dispose();
  });

  test('rebuildAll with 10,000 files across deep folder tree', () => {
    store.configureProvider('test', 100);
    // Create files in a directory tree: src/a/b/c/file.ts, etc.
    let idx = 0;
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        for (let c = 0; c < 10; c++) {
          for (let f = 0; f < 10; f++) {
            const uri = Uri.parse(
              `file:///project/src/${a}/${b}/${c}/file${idx}.ts`,
            );
            store.set(uri, makeState(idx % 2 === 0 ? 1 : 0), 'test');
            idx++;
          }
        }
      }
    }
    assert.strictEqual(store.size(), 10000);

    const start = performance.now();
    const changed = fsm.rebuildAll();
    const elapsed = performance.now() - start;

    // Should have aggregate entries for each directory level
    assert.ok(changed.length > 0, 'rebuildAll should return changed folder URIs');
    assert.ok(elapsed < 5000, `rebuildAll(10000 files, 4-level tree) took ${elapsed.toFixed(0)}ms (expected <5000ms)`);

    // verify root aggregate
    const rootState = store.get(Uri.parse('file:///project'));
    assert.ok(rootState !== undefined, 'root folder aggregate should exist');
    assert.strictEqual(rootState!.fileCount, 10000);
    assert.strictEqual(rootState!.errorCount, 5000);
  });

  test('updateAncestors after single file change (incremental, deep tree)', () => {
    store.configureProvider('test', 100);

    // First bulk insert with rebuild
    for (let i = 0; i < 5000; i++) {
      store.set(
        Uri.parse(`file:///project/src/a/b/c/d/e/f/g/h/file${i}.ts`),
        makeState(1),
        'test',
      );
    }
    fsm.rebuildAll();

    // Now change one file
    const changedFile = Uri.parse('file:///project/src/a/b/c/d/e/f/g/h/file999.ts');
    const start = performance.now();
    const ancestors = fsm.updateAncestors(changedFile);
    const elapsed = performance.now() - start;

    assert.ok(ancestors.length > 0);
    assert.ok(elapsed < 50, `updateAncestors(8-level deep) took ${elapsed.toFixed(2)}ms (expected <50ms)`);
  });
});
