import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../models/ProblemSeverity';
import { ProblemSource } from '../../models/ProblemSource';
import { ProblemState } from '../../models/ProblemState';
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

  test('set fires onDidChange with the uri', () => {
    const uri = Uri.parse('file:///project/a.ts');
    let received: Uri | undefined;
    const d = store.onDidChange((e) => { received = e; });
    store.set(uri, makeState());
    d.dispose();
    assert.ok(received);
    assert.strictEqual(received!.toString(), uri.toString());
  });

  test('delete fires onDidChange with the uri', () => {
    const uri = Uri.parse('file:///project/a.ts');
    store.set(uri, makeState());
    let received: Uri | undefined;
    const d = store.onDidChange((e) => { received = e; });
    store.delete(uri);
    d.dispose();
    assert.ok(received);
    assert.strictEqual(received!.toString(), uri.toString());
  });

  test('delete on non-existent key does not fire', () => {
    const uri = Uri.parse('file:///project/nonexistent.ts');
    let fired = false;
    const d = store.onDidChange(() => { fired = true; });
    store.delete(uri);
    d.dispose();
    assert.strictEqual(fired, false);
  });

  test('clear fires onDidChange with undefined', () => {
    store.set(Uri.parse('file:///project/a.ts'), makeState());
    let received: Uri | undefined = 'sentinel' as any;
    const d = store.onDidChange((e) => { received = e; });
    store.clear();
    d.dispose();
    assert.strictEqual(received, undefined);
  });

  test('multiple set operations fire multiple events', () => {
    const uris = [Uri.parse('file:///project/a.ts'), Uri.parse('file:///project/b.ts')];
    const received: string[] = [];
    const d = store.onDidChange((e) => { if (e) received.push(e.toString()); });
    store.set(uris[0], makeState());
    store.set(uris[1], makeState());
    d.dispose();
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0], uris[0].toString());
    assert.strictEqual(received[1], uris[1].toString());
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
});