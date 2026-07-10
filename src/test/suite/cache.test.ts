import * as assert from 'assert';
import * as vscode from 'vscode';
import { LruCache } from '../../cache/lruCache';
import { ProblemCache } from '../../cache/cacheLayer';
import { ProblemStatus, ProblemSeverity } from '../../core/types';

suite('LruCache', () => {
  test('get returns undefined for missing key', () => {
    const cache = new LruCache<string, number>(10);
    assert.strictEqual(cache.get('missing'), undefined);
  });

  test('set and get a value', () => {
    const cache = new LruCache<string, number>(10);
    cache.set('a', 1);
    assert.strictEqual(cache.get('a'), 1);
  });

  test('overwrite existing key', () => {
    const cache = new LruCache<string, number>(10);
    cache.set('a', 1);
    cache.set('a', 2);
    assert.strictEqual(cache.get('a'), 2);
  });

  test('evicts least recently used when over capacity', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('c'), 3);
    assert.strictEqual(cache.get('d'), 4);
  });

  test('accessing an item prevents its eviction', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');
    cache.set('d', 4);
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('b'), undefined);
  });

  test('has returns true for existing key', () => {
    const cache = new LruCache<string, number>(10);
    cache.set('a', 1);
    assert.strictEqual(cache.has('a'), true);
    assert.strictEqual(cache.has('missing'), false);
  });

  test('delete removes a key', () => {
    const cache = new LruCache<string, number>(10);
    cache.set('a', 1);
    assert.strictEqual(cache.delete('a'), true);
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.delete('missing'), false);
  });

  test('clear removes all entries', () => {
    const cache = new LruCache<string, number>(10);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(cache.get('a'), undefined);
  });

  test('rejects capacity < 1', () => {
    assert.throws(() => new LruCache<string, number>(0), /capacity/);
  });

  test('capacity of 1 keeps only most recent', () => {
    const cache = new LruCache<string, number>(1);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('b'), 2);
  });

  test('entries iterates over all key-value pairs', () => {
    const cache = new LruCache<string, number>(10);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    const result = Array.from(cache.entries());
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, [['a', 1], ['b', 2], ['c', 3]]);
  });

  test('entries returns correct pairs after eviction', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    const result = Array.from(cache.entries());
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0][0], 'b');
    assert.strictEqual(result[1][0], 'c');
  });

  test('entries returns nothing for empty cache', () => {
    const cache = new LruCache<string, number>(10);
    assert.strictEqual(Array.from(cache.entries()).length, 0);
  });
});

suite('ProblemCache', () => {
  const folderUri = vscode.Uri.parse('file:///workspace/');
  const fileA = vscode.Uri.parse('file:///workspace/src/a.ts');
  const fileB = vscode.Uri.parse('file:///workspace/src/b.ts');
  const differentFolder = vscode.Uri.parse('file:///other/');

  const statusError: ProblemStatus = {
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
  };

  const statusWarning: ProblemStatus = {
    severity: ProblemSeverity.Warning,
    errorCount: 0,
    warningCount: 1,
    infoCount: 0,
    fileCount: 1,
  };

  test('get returns undefined for uncached file', () => {
    const cache = new ProblemCache();
    assert.strictEqual(cache.get(fileA, folderUri), undefined);
  });

  test('set and get a file status', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    const result = cache.get(fileA, folderUri);
    assert.strictEqual(result?.severity, ProblemSeverity.Error);
  });

  test('set returns true for new entry', () => {
    const cache = new ProblemCache();
    assert.strictEqual(cache.set(fileA, statusError, folderUri), true);
  });

  test('set returns false when status has not changed', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    assert.strictEqual(cache.set(fileA, statusError, folderUri), false);
  });

  test('set returns true when status has changed', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    assert.strictEqual(cache.set(fileA, statusWarning, folderUri), true);
  });

  test('isolates different workspace folders', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    assert.strictEqual(cache.get(fileA, differentFolder), undefined);
  });

  test('delete removes entry', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    cache.delete(fileA, folderUri);
    assert.strictEqual(cache.get(fileA, folderUri), undefined);
  });

  test('clearFolder removes all entries for a folder', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    cache.set(fileB, statusWarning, folderUri);
    cache.clearFolder(folderUri);
    assert.strictEqual(cache.get(fileA, folderUri), undefined);
    assert.strictEqual(cache.get(fileB, folderUri), undefined);
  });

  test('clear removes all entries across all folders', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    cache.set(fileA, statusWarning, differentFolder);
    cache.clear();
    assert.strictEqual(cache.get(fileA, folderUri), undefined);
    assert.strictEqual(cache.get(fileA, differentFolder), undefined);
    assert.strictEqual(cache.getFolderSize(folderUri), 0);
    assert.strictEqual(cache.getFolderSize(differentFolder), 0);
  });

  test('getEntries returns all entries for a folder', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    cache.set(fileB, statusWarning, folderUri);
    const entries = cache.getEntries(folderUri);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0][1].severity, ProblemSeverity.Error);
    assert.strictEqual(entries[1][1].severity, ProblemSeverity.Warning);
  });

  test('getEntries returns empty for unknown folder', () => {
    const cache = new ProblemCache();
    const entries = cache.getEntries(differentFolder);
    assert.strictEqual(entries.length, 0);
  });

  test('getEntries does not include entries from other folders', () => {
    const cache = new ProblemCache();
    cache.set(fileA, statusError, folderUri);
    cache.set(fileA, statusWarning, differentFolder);
    const entries = cache.getEntries(folderUri);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0][1].severity, ProblemSeverity.Error);
  });

  test('setIgnorePredicate prevents ignored URIs from being cached', () => {
    const cache = new ProblemCache();
    cache.setIgnorePredicate((uri) => uri.toString().includes('node_modules'));
    const ignored = vscode.Uri.parse('file:///workspace/node_modules/pkg/index.js');
    const normal = vscode.Uri.parse('file:///workspace/src/app.ts');

    assert.strictEqual(cache.set(ignored, statusError, folderUri), false);
    assert.strictEqual(cache.set(normal, statusError, folderUri), true);
    assert.strictEqual(cache.get(ignored, folderUri), undefined);
    assert.strictEqual(cache.get(normal, folderUri)?.severity, ProblemSeverity.Error);
  });
});
