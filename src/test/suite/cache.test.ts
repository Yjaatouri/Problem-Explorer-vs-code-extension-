import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { ProblemState, ProblemSeverity } from '../../core/types';

suite('ProblemCache', () => {
  const folderUri = vscode.Uri.parse('file:///workspace/');
  const fileA = vscode.Uri.parse('file:///workspace/src/a.ts');
  const fileB = vscode.Uri.parse('file:///workspace/src/b.ts');
  const differentFolder = vscode.Uri.parse('file:///other/');

  const statusError: ProblemState = {
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
  };

  const statusWarning: ProblemState = {
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

  test('computeTotals aggregates across all folders', () => {
    const cache = new ProblemCache();
    const rootA = vscode.Uri.parse('file:///workspace/a');
    const rootB = vscode.Uri.parse('file:///workspace/b');

    cache.set(
      vscode.Uri.parse('file:///workspace/a/file1.ts'),
      { severity: ProblemSeverity.Error, errorCount: 2, warningCount: 0, infoCount: 0, fileCount: 1 },
      rootA,
    );
    cache.set(
      vscode.Uri.parse('file:///workspace/a/file2.ts'),
      { severity: ProblemSeverity.Warning, errorCount: 0, warningCount: 3, infoCount: 1, fileCount: 1 },
      rootA,
    );
    cache.set(
      vscode.Uri.parse('file:///workspace/b/file3.ts'),
      { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 },
      rootB,
    );

    const totals = cache.computeTotals();
    assert.strictEqual(totals.errorCount, 3);
    assert.strictEqual(totals.warningCount, 3);
    assert.strictEqual(totals.infoCount, 1);
    assert.strictEqual(totals.fileCount, 3);
    assert.strictEqual(totals.severity, ProblemSeverity.Error);
  });

  test('computeTotals returns zeros for empty cache', () => {
    const cache = new ProblemCache();
    const totals = cache.computeTotals();
    assert.strictEqual(totals.errorCount, 0);
    assert.strictEqual(totals.warningCount, 0);
    assert.strictEqual(totals.infoCount, 0);
    assert.strictEqual(totals.fileCount, 0);
    assert.strictEqual(totals.severity, ProblemSeverity.None);
  });

  test('getFileEntries returns only file entries, not folder aggregates', () => {
    const cache = new ProblemCache();
    const srcFile = vscode.Uri.parse('file:///workspace/a.ts');
    const subFolder = vscode.Uri.parse('file:///workspace/sub');
    cache.set(srcFile, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);
    cache.setFolderAggregate(subFolder, { severity: ProblemSeverity.Warning, errorCount: 0, warningCount: 2, infoCount: 0, fileCount: 1 }, folderUri);
    const files = cache.getFileEntries(folderUri);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0][0].toString(), srcFile.toString());
  });

  test('setFolderAggregate stores folders without affecting computeTotals', () => {
    const cache = new ProblemCache();
    const srcFile = vscode.Uri.parse('file:///workspace/a.ts');
    const subFolder = vscode.Uri.parse('file:///workspace/sub');
    cache.set(srcFile, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);
    cache.setFolderAggregate(subFolder, { severity: ProblemSeverity.Warning, errorCount: 0, warningCount: 2, infoCount: 0, fileCount: 1 }, folderUri);
    const totals = cache.computeTotals();
    assert.strictEqual(totals.errorCount, 1);
    assert.strictEqual(totals.warningCount, 0);
    assert.strictEqual(totals.fileCount, 1);
  });

  test('setFolderAggregate entry is readable via get', () => {
    const cache = new ProblemCache();
    const subFolder = vscode.Uri.parse('file:///workspace/sub');
    cache.setFolderAggregate(subFolder, { severity: ProblemSeverity.Error, errorCount: 3, warningCount: 0, infoCount: 0, fileCount: 2 }, folderUri);
    const status = cache.get(subFolder, folderUri);
    assert.ok(status);
    assert.strictEqual(status.errorCount, 3);
  });

  test('clearFolder removes file and folder entries', () => {
    const cache = new ProblemCache();
    const subFolder = vscode.Uri.parse('file:///workspace/sub');
    cache.set(fileA, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);
    cache.setFolderAggregate(subFolder, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);
    cache.clearFolder(folderUri);
    assert.strictEqual(cache.get(fileA, folderUri), undefined);
    assert.strictEqual(cache.get(subFolder, folderUri), undefined);
    assert.strictEqual(cache.getFolderSize(folderUri), 0);
  });

  test('deletePrefix removes exact URI and descendants', () => {
    const cache = new ProblemCache();
    const file1 = vscode.Uri.parse('file:///workspace/src/a/file1.ts');
    const file2 = vscode.Uri.parse('file:///workspace/src/a/sub/file2.ts');
    const other = vscode.Uri.parse('file:///workspace/src/b/file.ts');
    cache.set(file1, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);
    cache.set(file2, { severity: ProblemSeverity.Warning, errorCount: 0, warningCount: 1, infoCount: 0, fileCount: 1 }, folderUri);
    cache.set(other, { severity: ProblemSeverity.Info, errorCount: 0, warningCount: 0, infoCount: 1, fileCount: 1 }, folderUri);

    const removed = cache.deletePrefix(vscode.Uri.parse('file:///workspace/src/a'), folderUri);
    assert.strictEqual(removed.length, 2);
    assert.strictEqual(cache.get(file1, folderUri), undefined);
    assert.strictEqual(cache.get(file2, folderUri), undefined);
    assert.ok(cache.get(other, folderUri)); // sibling must survive
  });

  test('movePrefix re-keys a single file', () => {
    const cache = new ProblemCache();
    const oldFile = vscode.Uri.parse('file:///workspace/src/a.ts');
    const newFile = vscode.Uri.parse('file:///workspace/src/b.ts');
    cache.set(oldFile, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);

    const moved = cache.movePrefix(oldFile, newFile, folderUri);
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(cache.get(oldFile, folderUri), undefined);
    assert.ok(cache.get(newFile, folderUri));
  });

  test('movePrefix re-keys a folder and all descendants', () => {
    const cache = new ProblemCache();
    const oldDir = vscode.Uri.parse('file:///workspace/src/a');
    const newDir = vscode.Uri.parse('file:///workspace/src/b');
    const file1 = vscode.Uri.parse('file:///workspace/src/a/file1.ts');
    const file2 = vscode.Uri.parse('file:///workspace/src/a/sub/file2.ts');
    cache.set(file1, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, folderUri);
    cache.set(file2, { severity: ProblemSeverity.Warning, errorCount: 0, warningCount: 1, infoCount: 0, fileCount: 1 }, folderUri);
    cache.setFolderAggregate(oldDir, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 1, infoCount: 0, fileCount: 2 }, folderUri);

    const moved = cache.movePrefix(oldDir, newDir, folderUri);
    assert.strictEqual(moved.length, 3); // file1, file2, oldDir aggregate
    assert.strictEqual(cache.get(file1, folderUri), undefined);
    assert.strictEqual(cache.get(file2, folderUri), undefined);
    assert.strictEqual(cache.get(oldDir, folderUri), undefined);

    const movedFile1 = vscode.Uri.parse('file:///workspace/src/b/file1.ts');
    const movedFile2 = vscode.Uri.parse('file:///workspace/src/b/sub/file2.ts');
    const movedDir = vscode.Uri.parse('file:///workspace/src/b');
    assert.ok(cache.get(movedFile1, folderUri));
    assert.ok(cache.get(movedFile2, folderUri));
    assert.ok(cache.get(movedDir, folderUri)); // aggregate (no longer marked as folder key)
  });
});
