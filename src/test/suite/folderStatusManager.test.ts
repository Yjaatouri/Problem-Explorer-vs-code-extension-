import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { FolderStatusManager, FolderWorkspace } from '../../folder/folderStatusManager';
import { ProblemSeverity, ProblemStatus } from '../../core/types';

suite('FolderStatusManager', () => {
  const rootUri = Uri.parse('file:///workspace');
  const srcUri = Uri.parse('file:///workspace/src');
  const srcA = Uri.parse('file:///workspace/src/a');
  const fileA = Uri.parse('file:///workspace/src/a/file.ts');
  const fileB = Uri.parse('file:///workspace/src/b/file.ts');
  const fileRoot = Uri.parse('file:///workspace/root.ts');

  function makeWorkspace(folders: Uri[]): FolderWorkspace {
    const folderObjects = folders.map((uri, index) => ({
      uri,
      name: uri.path.split('/').filter(Boolean).pop() ?? 'root',
      index,
    }));
    return {
      workspaceFolders: folderObjects,
      getWorkspaceFolder: (uri: Uri) => {
        const str = uri.toString();
        let best: (typeof folderObjects)[0] | undefined;
        let bestLen = 0;
        for (const f of folderObjects) {
          const fStr = f.uri.toString();
          if (str === fStr || str.startsWith(fStr + '/')) {
            if (fStr.length > bestLen) {
              best = f;
              bestLen = fStr.length;
            }
          }
        }
        return best;
      },
    };
  }

  function status(severity: ProblemSeverity, counts?: Partial<ProblemStatus>): ProblemStatus {
    return {
      severity,
      errorCount: counts?.errorCount ?? (severity === ProblemSeverity.Error ? 1 : 0),
      warningCount: counts?.warningCount ?? (severity === ProblemSeverity.Warning ? 1 : 0),
      infoCount: counts?.infoCount ?? (severity === ProblemSeverity.Info ? 1 : 0),
    };
  }

  let cache: ProblemCache;
  let wf: FolderWorkspace;
  let manager: FolderStatusManager;

  setup(() => {
    cache = new ProblemCache();
    wf = makeWorkspace([rootUri]);
    manager = new FolderStatusManager(cache, wf);
  });

  suite('recomputeFolderStatus', () => {
    test('empty folder returns None severity', () => {
      const s = manager.recomputeFolderStatus(srcUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.None);
      assert.strictEqual(s.errorCount, 0);
    });

    test('single error child', () => {
      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      const s = manager.recomputeFolderStatus(srcUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
      assert.strictEqual(s.errorCount, 1);
    });

    test('worst severity wins across children', () => {
      cache.set(fileA, status(ProblemSeverity.Info), rootUri);
      cache.set(fileB, status(ProblemSeverity.Error), rootUri);
      const s = manager.recomputeFolderStatus(srcUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
    });

    test('counts are summed across children', () => {
      cache.set(
        fileA,
        status(ProblemSeverity.Error, { errorCount: 2, warningCount: 1, infoCount: 0 }),
        rootUri,
      );
      cache.set(
        fileB,
        status(ProblemSeverity.Warning, { errorCount: 0, warningCount: 3, infoCount: 2 }),
        rootUri,
      );
      const s = manager.recomputeFolderStatus(srcUri, rootUri);
      assert.strictEqual(s.errorCount, 2);
      assert.strictEqual(s.warningCount, 4);
      assert.strictEqual(s.infoCount, 2);
    });

    test('files at different nesting levels are aggregated', () => {
      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      cache.set(fileRoot, status(ProblemSeverity.Warning), rootUri);
      const s = manager.recomputeFolderStatus(rootUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
      assert.strictEqual(s.errorCount, 1);
      assert.strictEqual(s.warningCount, 1);
    });
  });

  suite('updateAncestors', () => {
    test('walks from file to root updating each ancestor', () => {
      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      const changed = manager.updateAncestors(fileA);

      assert.ok(changed.length >= 2);
      assert.ok(changed.some((u) => u.toString() === srcA.toString()));
      assert.ok(changed.some((u) => u.toString() === rootUri.toString()));
    });

    test('file directly in root updates only root', () => {
      cache.set(fileRoot, status(ProblemSeverity.Error), rootUri);
      const changed = manager.updateAncestors(fileRoot);

      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0].toString(), rootUri.toString());
    });

    test('no-op if no children changed', () => {
      cache.set(fileA, status(ProblemSeverity.None), rootUri);
      const changed = manager.updateAncestors(fileA);

      assert.strictEqual(changed.length, 0);
    });

    test('nested folders propagate correctly', () => {
      cache.set(fileA, status(ProblemSeverity.Error, { errorCount: 3 }), rootUri);
      manager.updateAncestors(fileA);

      const aDir = cache.get(srcA, rootUri);
      assert.strictEqual(aDir?.severity, ProblemSeverity.Error);
      assert.strictEqual(aDir?.errorCount, 3);

      const srcDir = cache.get(srcUri, rootUri);
      assert.strictEqual(srcDir?.severity, ProblemSeverity.Error);
      assert.strictEqual(srcDir?.errorCount, 3);

      const rootDir = cache.get(rootUri, rootUri);
      assert.strictEqual(rootDir?.severity, ProblemSeverity.Error);
      assert.strictEqual(rootDir?.errorCount, 3);
    });

    test('file outside workspace returns empty', () => {
      const outside = Uri.parse('file:///outside/file.ts');
      const changed = manager.updateAncestors(outside);
      assert.strictEqual(changed.length, 0);
    });
  });

  suite('rebuildAll', () => {
    test('rebuilds all folder statuses from scratch', () => {
      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      cache.set(fileB, status(ProblemSeverity.Warning), rootUri);

      const changed = manager.rebuildAll();

      assert.ok(changed.length > 0);

      const rootDir = cache.get(rootUri, rootUri);
      assert.strictEqual(rootDir?.severity, ProblemSeverity.Error);
    });

    test('empty cache produces no changes', () => {
      const changed = manager.rebuildAll();
      assert.strictEqual(changed.length, 0);
    });
  });

  suite('aggregation (worst-severity-wins)', () => {
    test('Error beats Warning', () => {
      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      cache.set(fileB, status(ProblemSeverity.Warning), rootUri);
      const s = manager.recomputeFolderStatus(rootUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
    });

    test('Warning beats Info', () => {
      cache.set(fileA, status(ProblemSeverity.Warning), rootUri);
      cache.set(fileB, status(ProblemSeverity.Info), rootUri);
      const s = manager.recomputeFolderStatus(rootUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Warning);
    });

    test('Info beats None', () => {
      cache.set(fileA, status(ProblemSeverity.Info), rootUri);
      cache.set(fileB, status(ProblemSeverity.None), rootUri);
      const s = manager.recomputeFolderStatus(rootUri, rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Info);
    });
  });
});
