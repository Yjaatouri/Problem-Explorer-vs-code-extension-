import * as assert from 'assert';
import { Uri } from 'vscode';
import { normalizeUriKey } from '../../core/uriKey';
import { ProblemCache } from '../../cache/cacheLayer';
import { ProblemSeverity, ProblemState } from '../../core/types';

suite('normalizeUriKey', () => {
  test('drive letter casing maps to the same key', () => {
    const a = Uri.parse('file:///c%3A/project/src/a.ts');
    const b = Uri.parse('file:///C%3A/project/src/a.ts');
    assert.strictEqual(normalizeUriKey(a), normalizeUriKey(b));
  });

  test('trailing slash is stripped', () => {
    const a = Uri.parse('file:///workspace/');
    const b = Uri.parse('file:///workspace');
    assert.strictEqual(normalizeUriKey(a), normalizeUriKey(b));
  });

  test('distinct paths remain distinct', () => {
    const a = Uri.parse('file:///workspace/a.ts');
    const b = Uri.parse('file:///workspace/b.ts');
    assert.notStrictEqual(normalizeUriKey(a), normalizeUriKey(b));
  });

  test('non-file schemes are preserved', () => {
    const a = Uri.parse('untitled:Untitled-1');
    assert.strictEqual(normalizeUriKey(a), a.toString());
  });
});

suite('ProblemCache URI normalization', () => {
  const status: ProblemState = {
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
  };

  test('different drive-letter casing resolves to one entry', () => {
    const cache = new ProblemCache();
    const folderLower = Uri.parse('file:///c%3A/project');
    const folderUpper = Uri.parse('file:///C%3A/project');
    const fileLower = Uri.parse('file:///c%3A/project/src/a.ts');
    const fileUpper = Uri.parse('file:///C%3A/project/src/a.ts');

    cache.set(fileLower, status, folderLower);
    assert.strictEqual(cache.get(fileUpper, folderUpper)?.severity, ProblemSeverity.Error);
    assert.strictEqual(cache.getFolderSize(folderUpper), 1);
  });

  test('trailing slash on folder URI resolves to same folder cache', () => {
    const cache = new ProblemCache();
    const folderA = Uri.parse('file:///workspace/');
    const folderB = Uri.parse('file:///workspace');
    const file = Uri.parse('file:///workspace/src/a.ts');

    cache.set(file, status, folderA);
    assert.strictEqual(cache.get(file, folderB)?.severity, ProblemSeverity.Error);
  });
});
