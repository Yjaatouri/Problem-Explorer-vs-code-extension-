import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../models/ProblemSeverity';
import { ProblemSource } from '../../models/ProblemSource';
import { ProblemState } from '../../models/ProblemState';
import { ProblemStoreChange } from '../../models/ProblemStoreChange';
import { normalizeUriKey } from '../../core/uriKey';

function makeState(overrides?: Partial<ProblemState>): ProblemState {
  const DEFAULT_URI = Uri.parse('file:///project/a.ts');
  const DEFAULT_FOLDER = Uri.parse('file:///project');
  return {
    uri: normalizeUriKey(DEFAULT_URI),
    folderKey: normalizeUriKey(DEFAULT_FOLDER),
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
    source: ProblemSource.TypeScript,
    updatedAt: Date.now(),
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
    assert.strictEqual(retrieved.source, ProblemSource.TypeScript);
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
    store.set(a, makeState({ uri: normalizeUriKey(a) }));
    store.set(b, makeState({ uri: normalizeUriKey(b) }));
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
    store.set(
      Uri.parse('file:///project/a.ts'),
      makeState({ uri: normalizeUriKey(Uri.parse('file:///project/a.ts')) }),
    );
    assert.strictEqual(store.size(), 1);
    store.set(
      Uri.parse('file:///project/b.ts'),
      makeState({ uri: normalizeUriKey(Uri.parse('file:///project/b.ts')) }),
    );
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
    store.set(a, makeState({ uri: normalizeUriKey(a), errorCount: 1 }));
    store.set(b, makeState({ uri: normalizeUriKey(b), errorCount: 2 }));
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

  test('snapshot does not reflect subsequent store mutations', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState({ errorCount: 1 }));
    const snap = store.snapshot();
    store.set(uri, makeState({ errorCount: 5 }));
    const key = normalizeUriKey(uri);
    assert.strictEqual(snap[key].errorCount, 1);
  });
});