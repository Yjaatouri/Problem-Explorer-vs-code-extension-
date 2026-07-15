import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity, ProblemState } from '../../core/types';
import { ProblemStoreChange } from '../../models/ProblemStoreChange';
import { normalizeUriKey } from '../../core/uriKey';

function makeState(overrides?: Partial<ProblemState>): ProblemState {
  return {
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
    ...overrides,
  };
}

suite('ProblemStore', () => {
  let store: ProblemStore;

  setup(() => {
    store = new ProblemStore();
  });

  test('insert', () => {
    const uri = Uri.parse('file:///project/a.ts');
    const state = makeState();
    store.set(uri, state);
    assert.strictEqual(store.has(uri), true);
    assert.strictEqual(store.size(), 1);
  });

  test('get returns the inserted state', () => {
    const uri = Uri.parse('file:///project/a.ts');
    const state = makeState();
    store.set(uri, state);
    const retrieved = store.get(uri);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.severity, ProblemSeverity.Error);
    assert.strictEqual(retrieved.errorCount, 1);
  });

  test('get returns undefined for missing key', () => {
    const uri = Uri.parse('file:///project/nonexistent.ts');
    assert.strictEqual(store.get(uri), undefined);
  });

  test('update overwrites existing state', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState({ errorCount: 1 }));
    store.set(uri, makeState({ errorCount: 3, severity: ProblemSeverity.Warning }));
    const retrieved = store.get(uri);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.errorCount, 3);
    assert.strictEqual(retrieved.severity, ProblemSeverity.Warning);
  });

  test('delete removes the entry and returns true', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState());
    assert.strictEqual(store.has(uri), true);
    const result = store.delete(uri);
    assert.strictEqual(result, true);
    assert.strictEqual(store.has(uri), false);
    assert.strictEqual(store.size(), 0);
  });

  test('delete returns false for non-existent key', () => {
    const uri = Uri.parse('file:///project/nonexistent.ts');
    assert.strictEqual(store.delete(uri), false);
  });

  test('clear removes all entries', () => {
    const a = Uri.parse('file:///project/a.ts');
    const b = Uri.parse('file:///project/b.ts');
    store.set(a, makeState());
    store.set(b, makeState());
    assert.strictEqual(store.size(), 2);
    store.clear();
    assert.strictEqual(store.size(), 0);
    assert.strictEqual(store.has(a), false);
    assert.strictEqual(store.has(b), false);
  });

  test('has returns true when present, false when absent', () => {
    const uri = Uri.parse('file:///project/a.ts');
    assert.strictEqual(store.has(uri), false);
    store.set(uri, makeState());
    assert.strictEqual(store.has(uri), true);
    store.delete(uri);
    assert.strictEqual(store.has(uri), false);
  });

  test('size reflects entry count', () => {
    assert.strictEqual(store.size(), 0);
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    assert.strictEqual(store.size(), 1);
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    assert.strictEqual(store.size(), 2);
    store.delete(Uri.parse('file:///project/a.ts'));
    assert.strictEqual(store.size(), 1);
  });

  test('dispose clears storage', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.dispose();
    assert.strictEqual(store.size(), 0);
  });

  test('set fires added event for new entry', () => {
    const uri = Uri.parse('file:///project/a.ts');
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.set(uri, makeState());
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'added');
    assert.strictEqual((events[0] as any).uri?.toString(), uri.toString());
  });

  test('set does not fire event when state is unchanged', () => {
    const uri = Uri.parse('file:///project/a.ts');
    const state = makeState();
    store.set(uri, state);
    let fired = false;
    const d = store.onDidChange(() => { fired = true; });
    store.set(uri, state);
    d.dispose();
    assert.strictEqual(fired, false);
  });

  test('set fires updated event for existing entry', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState());
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.set(uri, makeState({ errorCount: 2 }));
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'updated');
    assert.strictEqual((events[0] as any).uri?.toString(), uri.toString());
  });

  test('delete fires removed event', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState());
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.delete(uri);
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'removed');
    assert.strictEqual((events[0] as any).uri?.toString(), uri.toString());
  });

  test('delete on non-existent key does not fire', () => {
    const uri = Uri.parse('file:///project/nonexistent.ts');
    let fired = false;
    const d = store.onDidChange(() => { fired = true; });
    store.delete(uri);
    d.dispose();
    assert.strictEqual(fired, false);
  });

  test('clear fires cleared event', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.clear();
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'cleared');
  });

  test('multiple set operations fire multiple events', () => {
    const uris = [Uri.parse('file:///project/a.ts'), Uri.parse('file:///project/b.ts')];
    const kinds: string[] = [];
    const d = store.onDidChange((e) => kinds.push(e.kind));
    store.set(uris[0], makeState());
    store.set(uris[1], makeState());
    d.dispose();
    assert.deepStrictEqual(kinds, ['added', 'added']);
  });

  test('dispose stops firing onDidChange', () => {
    const uri = Uri.parse('file:///project/a.ts');
    let fired = false;
    const d = store.onDidChange(() => { fired = true; });
    store.dispose();
    store.set(uri, makeState());
    d.dispose();
    assert.strictEqual(fired, false);
  });

  test('beginBatch/endBatch fires single batch event', () => {
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.beginBatch();
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    store.endBatch();
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'batch');
  });

  test('individual events suppressed during batch', () => {
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.beginBatch();
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.delete(Uri.parse('file:///project/b.ts'));
    store.clear();
    store.endBatch();
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'batch');
  });

  test('endBatch without beginBatch does nothing', () => {
    let fired = false;
    const d = store.onDidChange(() => { fired = true; });
    store.endBatch();
    d.dispose();
    assert.strictEqual(fired, false);
  });

  test('nested beginBatch/endBatch fires only on outer endBatch', () => {
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.beginBatch();
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.beginBatch();
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    store.endBatch();
    assert.strictEqual(events.length, 0);
    store.set(Uri.parse('file:///project/c.ts'), makeState());
    store.endBatch();
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'batch');
  });

  test('fires individual events after batch ends', () => {
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.beginBatch();
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.endBatch();
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    d.dispose();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].kind, 'batch');
    assert.strictEqual(events[1].kind, 'added');
  });

  test('getVersion starts at 0', () => {
    assert.strictEqual(store.getVersion(), 0);
  });

  test('getVersion increments on set', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    assert.strictEqual(store.getVersion(), 1);
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    assert.strictEqual(store.getVersion(), 2);
  });

  test('getVersion increments on delete', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    assert.strictEqual(store.getVersion(), 1);
    store.delete(Uri.parse('file:///project/a.ts'));
    assert.strictEqual(store.getVersion(), 2);
  });

  test('getVersion does not increment on no-op delete', () => {
    store.delete(Uri.parse('file:///project/nonexistent.ts'));
    assert.strictEqual(store.getVersion(), 0);
  });

  test('getVersion increments on clear', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    store.clear();
    assert.strictEqual(store.getVersion(), 3);
  });

  test('getVersion increments during batch', () => {
    store.beginBatch();
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    store.set(Uri.parse('file:///project/b.ts'), makeState());
    store.endBatch();
    assert.strictEqual(store.getVersion(), 2);
  });

  test('snapshot returns all entries', () => {
    const a = Uri.parse('file:///project/a.ts');
    const b = Uri.parse('file:///project/b.ts');
    store.set(a, makeState({ errorCount: 1 }));
    store.set(b, makeState({ errorCount: 2 }));
    const snap = store.snapshot();
    assert.strictEqual(Object.keys(snap).length, 2);
    assert.strictEqual(snap[normalizeUriKey(a)].errorCount, 1);
    assert.strictEqual(snap[normalizeUriKey(b)].errorCount, 2);
  });

  test('snapshot returns empty object for empty store', () => {
    const snap = store.snapshot();
    assert.deepStrictEqual(snap, {});
  });

  test('snapshot is immutable to external mutation', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState());
    const snap = store.snapshot();
    const key = normalizeUriKey(uri);
    assert.throws(() => { (snap as any)[key] = null; }, TypeError);
  });

  test('snapshot state objects are immutable copies', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState());
    const snap = store.snapshot();
    const key = normalizeUriKey(uri);
    assert.throws(() => { (snap[key] as any).errorCount = 99; }, TypeError);
  });

  test('deleteByPrefix removes matching entries', () => {
    const a = Uri.parse('file:///project/src/a/file.ts');
    const b = Uri.parse('file:///project/src/a/sub/file2.ts');
    const c = Uri.parse('file:///project/src/b/file.ts');
    store.set(a, makeState());
    store.set(b, makeState());
    store.set(c, makeState());
    assert.strictEqual(store.size(), 3);

    const count = store.deleteByPrefix('file:///project/src/a');
    assert.strictEqual(count, 2);
    assert.strictEqual(store.get(a), undefined);
    assert.strictEqual(store.get(b), undefined);
    assert.ok(store.get(c));
  });

  test('movePrefix re-keys entries from old prefix to new prefix', () => {
    const oldA = Uri.parse('file:///project/src/a/file.ts');
    const oldB = Uri.parse('file:///project/src/a/sub/file2.ts');
    const newA = Uri.parse('file:///project/src/b/file.ts');
    const newB = Uri.parse('file:///project/src/b/sub/file2.ts');
    store.set(oldA, makeState({ errorCount: 1 }));
    store.set(oldB, makeState({ errorCount: 2 }));

    const count = store.movePrefix('file:///project/src/a', 'file:///project/src/b');
    assert.strictEqual(count, 2);
    assert.strictEqual(store.get(oldA), undefined);
    assert.strictEqual(store.get(oldB), undefined);
    assert.strictEqual(store.get(newA)?.errorCount, 1);
    assert.strictEqual(store.get(newB)?.errorCount, 2);
  });

  test('movePrefix preserves folder-aggregate markers', () => {
    const oldDir = Uri.parse('file:///project/src/a');
    const newDir = Uri.parse('file:///project/src/b');
    store.setFolderAggregate(oldDir, makeState({ errorCount: 3, fileCount: 2 }));

    store.movePrefix('file:///project/src/a', 'file:///project/src/b');
    assert.strictEqual(store.get(oldDir), undefined);
    assert.ok(store.isFolderAggregate(newDir));
    assert.strictEqual(store.get(newDir)?.errorCount, 3);
  });

  test('movePrefix fires prefixMoved event', () => {
    store.set(Uri.parse('file:///project/src/a/file.ts'), makeState());
    const events: ProblemStoreChange[] = [];
    const d = store.onDidChange((e) => events.push(e));
    store.movePrefix('file:///project/src/a', 'file:///project/src/b');
    d.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'prefixMoved');
    if (events[0].kind === 'prefixMoved') {
      assert.strictEqual(events[0].oldPrefix, 'file:///project/src/a');
      assert.strictEqual(events[0].newPrefix, 'file:///project/src/b');
    }
  });

  test('movePrefix returns 0 when oldPrefix equals newPrefix', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    const count = store.movePrefix('file:///project', 'file:///project');
    assert.strictEqual(count, 0);
    assert.strictEqual(store.size(), 1);
  });

  test('snapshot does not reflect subsequent store mutations', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState({ errorCount: 1 }));
    const snap = store.snapshot();
    store.set(uri, makeState({ errorCount: 5 }));
    const key = normalizeUriKey(uri);
    assert.strictEqual(snap[key].errorCount, 1);
  });

  // Ownership / Provider Priority tests

  test('configureProvider registers provider priority', () => {
    store.configureProvider('providerA', 100);
    assert.strictEqual(store.getProviderPriority('providerA'), 100);
  });

  test('unconfigureProvider removes provider priority', () => {
    store.configureProvider('providerA', 100);
    store.unconfigureProvider('providerA');
    assert.strictEqual(store.getProviderPriority('providerA'), -1);
  });

  test('unconfigureProvider on unknown provider is no-op', () => {
    store.unconfigureProvider('unknown');
    assert.strictEqual(store.getProviderPriority('unknown'), -1);
  });

  test('higher priority provider wins ownership', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('low', 10);
    store.configureProvider('high', 100);

    // Low priority writes first
    store.set(uri, makeState({ errorCount: 1 }), 'low');
    assert.strictEqual(store.getOwningProvider(uri), 'low');

    // High priority writes - should take ownership
    const result = store.set(uri, makeState({ errorCount: 2 }), 'high');
    assert.strictEqual(result, true);
    assert.strictEqual(store.getOwningProvider(uri), 'high');
    assert.strictEqual(store.get(uri)?.errorCount, 2);
  });

  test('lower priority provider write is rejected', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('high', 100);
    store.configureProvider('low', 10);

    // High priority writes first
    store.set(uri, makeState({ errorCount: 1 }), 'high');
    assert.strictEqual(store.getOwningProvider(uri), 'high');

    // Low priority tries to write - should be rejected
    const result = store.set(uri, makeState({ errorCount: 2 }), 'low');
    assert.strictEqual(result, false);
    assert.strictEqual(store.getOwningProvider(uri), 'high');
    assert.strictEqual(store.get(uri)?.errorCount, 1);
  });

  test('same priority provider write succeeds (last write wins)', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('p1', 50);
    store.configureProvider('p2', 50);

    store.set(uri, makeState({ errorCount: 1 }), 'p1');
    assert.strictEqual(store.getOwningProvider(uri), 'p1');

    // Same priority - write should succeed
    const result = store.set(uri, makeState({ errorCount: 2 }), 'p2');
    assert.strictEqual(result, true);
    assert.strictEqual(store.getOwningProvider(uri), 'p2');
    assert.strictEqual(store.get(uri)?.errorCount, 2);
  });

  test('unconfigured provider has priority -1 (lowest)', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('configured', 50);

    store.set(uri, makeState({ errorCount: 1 }), 'configured');
    assert.strictEqual(store.getOwningProvider(uri), 'configured');

    // Unconfigured provider has priority -1, should be rejected
    const result = store.set(uri, makeState({ errorCount: 2 }), 'unconfigured');
    assert.strictEqual(result, false);
    assert.strictEqual(store.getOwningProvider(uri), 'configured');
  });

  test('write without providerName ignores ownership (legacy behavior)', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('p1', 100);

    store.set(uri, makeState({ errorCount: 1 }), 'p1');
    assert.strictEqual(store.getOwningProvider(uri), 'p1');

    // Write without providerName should succeed (legacy mode)
    const result = store.set(uri, makeState({ errorCount: 2 }));
    assert.strictEqual(result, true);
    // Ownership unchanged
    assert.strictEqual(store.getOwningProvider(uri), 'p1');
  });

  test('releaseOwnership releases all keys owned by provider', () => {
    const a = Uri.parse('file:///project/a.ts');
    const b = Uri.parse('file:///project/b.ts');
    store.configureProvider('p1', 100);

    store.set(a, makeState({ errorCount: 1 }), 'p1');
    store.set(b, makeState({ errorCount: 1 }), 'p1');
    assert.strictEqual(store.getOwningProvider(a), 'p1');
    assert.strictEqual(store.getOwningProvider(b), 'p1');

    store.releaseOwnership('p1');
    assert.strictEqual(store.getOwningProvider(a), undefined);
    assert.strictEqual(store.getOwningProvider(b), undefined);
  });

  test('releaseOwnership allows other provider to claim keys', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('p1', 100);
    store.configureProvider('p2', 50);

    store.set(uri, makeState({ errorCount: 1 }), 'p1');
    assert.strictEqual(store.getOwningProvider(uri), 'p1');

    store.releaseOwnership('p1');
    assert.strictEqual(store.getOwningProvider(uri), undefined);

    // p2 can now claim the key
    const result = store.set(uri, makeState({ errorCount: 2 }), 'p2');
    assert.strictEqual(result, true);
    assert.strictEqual(store.getOwningProvider(uri), 'p2');
  });

  test('releaseOwnership on unknown provider is no-op', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.configureProvider('p1', 100);
    store.set(uri, makeState({ errorCount: 1 }), 'p1');

    store.releaseOwnership('unknown');
    assert.strictEqual(store.getOwningProvider(uri), 'p1');
  });

  test('dispose clears ownership and priorities', () => {
    store.configureProvider('p1', 100);
    store.set(Uri.parse('file:///project/a.ts'), makeState({ errorCount: 1 }), 'p1');

    store.dispose();

    assert.strictEqual(store.getProviderPriority('p1'), -1);
    assert.strictEqual(store.size(), 0);
  });

  test('deleteByPrefix releases ownership for deleted keys', () => {
    const a = Uri.parse('file:///project/src/a/file.ts');
    const b = Uri.parse('file:///project/src/a/sub/file2.ts');
    const c = Uri.parse('file:///project/src/b/file.ts');
    store.configureProvider('p1', 100);

    store.set(a, makeState(), 'p1');
    store.set(b, makeState(), 'p1');
    store.set(c, makeState(), 'p1');
    assert.strictEqual(store.getOwningProvider(a), 'p1');
    assert.strictEqual(store.getOwningProvider(b), 'p1');
    assert.strictEqual(store.getOwningProvider(c), 'p1');

    store.deleteByPrefix('file:///project/src/a');
    assert.strictEqual(store.getOwningProvider(a), undefined);
    assert.strictEqual(store.getOwningProvider(b), undefined);
    assert.strictEqual(store.getOwningProvider(c), 'p1');
  });

  test('movePrefix preserves ownership for moved keys', () => {
    const oldA = Uri.parse('file:///project/src/a/file.ts');
    const newA = Uri.parse('file:///project/src/b/file.ts');
    store.configureProvider('p1', 100);

    store.set(oldA, makeState({ errorCount: 1 }), 'p1');
    assert.strictEqual(store.getOwningProvider(oldA), 'p1');

    store.movePrefix('file:///project/src/a', 'file:///project/src/b');
    assert.strictEqual(store.getOwningProvider(oldA), undefined);
    assert.strictEqual(store.getOwningProvider(newA), 'p1');
  });

  test('folder aggregates bypass ownership (no providerName)', () => {
    const dir = Uri.parse('file:///project/src');
    store.configureProvider('p1', 100);

    store.set(dir, makeState({ errorCount: 1 }), 'p1');
    assert.strictEqual(store.getOwningProvider(dir), 'p1');

    // Folder aggregate uses setFolderAggregate without providerName
    store.setFolderAggregate(dir, makeState({ errorCount: 2 }));
    assert.strictEqual(store.getOwningProvider(dir), 'p1');
  });
});