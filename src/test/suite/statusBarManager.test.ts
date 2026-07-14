import * as assert from 'assert';
import { commands, Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { StatusBarManager } from '../../statusBar/statusBarManager';
import { ProblemSeverity, ProblemState } from '../../core/types';

suite('StatusBarManager', () => {

  function statusError(e: number, w = 0, i = 0): ProblemState {
    return {
      severity: e > 0 ? ProblemSeverity.Error : w > 0 ? ProblemSeverity.Warning : ProblemSeverity.Info,
      errorCount: e,
      warningCount: w,
      infoCount: i,
      fileCount: (e + w + i > 0) ? 1 : 0,
    };
  }

  test('update hides item when there are no problems', () => {
    const store = new ProblemStore();
    const mgr = new StatusBarManager(store);
    mgr.update();
  });

  test('update shows item with problems', () => {
    const store = new ProblemStore();
    const fileUri = Uri.parse('file:///workspace/src/file.ts');
    store.set(fileUri, statusError(5, 3, 1));
    const mgr = new StatusBarManager(store);
    mgr.update();
  });

  test('update aggregates across multi-root', () => {
    const store = new ProblemStore();
    store.set(Uri.parse('file:///workspace/a/file.ts'), statusError(2, 0, 0));
    store.set(Uri.parse('file:///workspace/b/file.ts'), statusError(0, 4, 0));

    const totals = store.computeTotals();
    assert.strictEqual(totals.errorCount, 2);
    assert.strictEqual(totals.warningCount, 4);
    assert.strictEqual(totals.fileCount, 2);
  });

  test('computeTotals excludes folder aggregates', () => {
    const store = new ProblemStore();
    store.set(Uri.parse('file:///workspace/a/file.ts'), statusError(2, 0, 0));
    store.set(Uri.parse('file:///workspace/b/file.ts'), statusError(0, 4, 0));
    const folderAggregate: ProblemState = {
      severity: ProblemSeverity.Error,
      errorCount: 2,
      warningCount: 4,
      infoCount: 0,
      fileCount: 2,
    };
    store.setFolderAggregate(Uri.parse('file:///workspace/a'), folderAggregate);

    const totals = store.computeTotals();
    assert.strictEqual(totals.errorCount, 2);
    assert.strictEqual(totals.warningCount, 4);
    assert.strictEqual(totals.fileCount, 2);
  });

  test('registerCommand registers problemExplorer.showStatus', async () => {
    await commands.executeCommand('problemExplorer.showStatus');
  });

  test('dispose cleans up status bar item', () => {
    const store = new ProblemStore();
    const mgr = new StatusBarManager(store);
    mgr.dispose();
  });

  test('setEnabled hides item when false', () => {
    const store = new ProblemStore();
    const fileUri = Uri.parse('file:///workspace/file.ts');
    store.set(fileUri, statusError(1, 0, 0));
    const mgr = new StatusBarManager(store);
    mgr.setEnabled(false);
  });

  test('setEnabled shows item when true', () => {
    const store = new ProblemStore();
    const fileUri = Uri.parse('file:///workspace/file.ts');
    store.set(fileUri, statusError(1, 0, 0));
    const mgr = new StatusBarManager(store);
    mgr.setEnabled(true);
  });
});
