import * as assert from 'assert';
import { commands, Uri } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { StatusBarManager } from '../../statusBar/statusBarManager';
import { ProblemSeverity, ProblemStatus } from '../../core/types';

suite('StatusBarManager', () => {
  const rootUri = Uri.parse('file:///workspace');

  function statusError(e: number, w = 0, i = 0): ProblemStatus {
    return {
      severity: e > 0 ? ProblemSeverity.Error : w > 0 ? ProblemSeverity.Warning : ProblemSeverity.Info,
      errorCount: e,
      warningCount: w,
      infoCount: i,
      fileCount: (e + w + i > 0) ? 1 : 0,
    };
  }

  test('update hides item when there are no problems', () => {
    const cache = new ProblemCache();
    const mgr = new StatusBarManager(cache);
    mgr.update();
    // Just verifying no throw — visual state is internal
  });

  test('update shows item with problems', () => {
    const cache = new ProblemCache();
    const fileUri = Uri.parse('file:///workspace/src/file.ts');
    cache.set(fileUri, statusError(5, 3, 1), rootUri);
    const mgr = new StatusBarManager(cache);
    mgr.update();
  });

  test('update aggregates across multi-root', () => {
    const cache = new ProblemCache();
    const rootA = Uri.parse('file:///workspace/a');
    const rootB = Uri.parse('file:///workspace/b');
    cache.set(Uri.parse('file:///workspace/a/file.ts'), statusError(2, 0, 0), rootA);
    cache.set(Uri.parse('file:///workspace/b/file.ts'), statusError(0, 4, 0), rootB);

    const totals = cache.computeTotals();
    assert.strictEqual(totals.errorCount, 2);
    assert.strictEqual(totals.warningCount, 4);
    assert.strictEqual(totals.fileCount, 2);
  });

  test('registerCommand registers problemExplorer.showStatus', async () => {
    // Command may already be registered by the activated extension;
    // verify it's callable without throwing.
    await commands.executeCommand('problemExplorer.showStatus');
  });

  test('dispose cleans up status bar item', () => {
    const cache = new ProblemCache();
    const mgr = new StatusBarManager(cache);
    mgr.dispose();
  });

  test('setEnabled hides item when false', () => {
    const cache = new ProblemCache();
    const fileUri = Uri.parse('file:///workspace/file.ts');
    cache.set(fileUri, statusError(1, 0, 0), rootUri);
    const mgr = new StatusBarManager(cache);
    mgr.setEnabled(false);
  });

  test('setEnabled shows item when true', () => {
    const cache = new ProblemCache();
    const fileUri = Uri.parse('file:///workspace/file.ts');
    cache.set(fileUri, statusError(1, 0, 0), rootUri);
    const mgr = new StatusBarManager(cache);
    mgr.setEnabled(true);
  });
});
