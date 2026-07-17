import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { FolderStatusManager, FolderWorkspace } from '../../folder/folderStatusManager';
import { ProblemSeverity, ProblemState } from '../../core/types';

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

  function status(severity: ProblemSeverity, counts?: Partial<ProblemState>): ProblemState {
    return {
      severity,
      errorCount: counts?.errorCount ?? (severity === ProblemSeverity.Error ? 1 : 0),
      warningCount: counts?.warningCount ?? (severity === ProblemSeverity.Warning ? 1 : 0),
      infoCount: counts?.infoCount ?? (severity === ProblemSeverity.Info ? 1 : 0),
      fileCount: counts?.fileCount ?? (severity !== ProblemSeverity.None ? 1 : 0),
    };
  }

  let store: ProblemStore;
  let wf: FolderWorkspace;
  let manager: FolderStatusManager;

  setup(() => {
    store = new ProblemStore();
    wf = makeWorkspace([rootUri]);
    manager = new FolderStatusManager(store, wf);
  });

  suite('recomputeFolderStatus', () => {
    test('empty folder returns None severity', () => {
      const s = manager.recomputeFolderStatus(srcUri);
      assert.strictEqual(s.severity, ProblemSeverity.None);
      assert.strictEqual(s.errorCount, 0);
    });

    test('single error child', () => {
      store.set(fileA, status(ProblemSeverity.Error));
      const s = manager.recomputeFolderStatus(srcUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
      assert.strictEqual(s.errorCount, 1);
    });

    test('worst severity wins across children', () => {
      store.set(fileA, status(ProblemSeverity.Info));
      store.set(fileB, status(ProblemSeverity.Error));
      const s = manager.recomputeFolderStatus(srcUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
    });

    test('counts are summed across children', () => {
      store.set(
        fileA,
        status(ProblemSeverity.Error, { errorCount: 2, warningCount: 1, infoCount: 0 }),
      );
      store.set(
        fileB,
        status(ProblemSeverity.Warning, { errorCount: 0, warningCount: 3, infoCount: 2 }),
      );
      const s = manager.recomputeFolderStatus(srcUri);
      assert.strictEqual(s.errorCount, 2);
      assert.strictEqual(s.warningCount, 4);
      assert.strictEqual(s.infoCount, 2);
    });

    test('files at different nesting levels are aggregated', () => {
      store.set(fileA, status(ProblemSeverity.Error));
      store.set(fileRoot, status(ProblemSeverity.Warning));
      const s = manager.recomputeFolderStatus(rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
      assert.strictEqual(s.errorCount, 1);
      assert.strictEqual(s.warningCount, 1);
    });
  });

  suite('updateAncestors', () => {
    test('walks from file to root updating each ancestor', () => {
      store.set(fileA, status(ProblemSeverity.Error));
      const changed = manager.updateAncestors(fileA);

      assert.ok(changed.length >= 2);
      assert.ok(changed.some((u) => u.toString() === srcA.toString()));
      assert.ok(changed.some((u) => u.toString() === rootUri.toString()));
    });

    test('file directly in root updates only root', () => {
      store.set(fileRoot, status(ProblemSeverity.Error));
      const changed = manager.updateAncestors(fileRoot);

      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0].toString(), rootUri.toString());
    });

    test('no-op if no children changed', () => {
      // No file entry in store means ancestors are unchanged
      const changed = manager.updateAncestors(fileA);

      assert.strictEqual(changed.length, 0);
    });

    test('nested folders propagate correctly', () => {
      store.set(fileA, status(ProblemSeverity.Error, { errorCount: 3 }));
      manager.updateAncestors(fileA);

      const aDir = store.get(srcA);
      assert.strictEqual(aDir?.severity, ProblemSeverity.Error);
      assert.strictEqual(aDir?.errorCount, 3);

      const srcDir = store.get(srcUri);
      assert.strictEqual(srcDir?.severity, ProblemSeverity.Error);
      assert.strictEqual(srcDir?.errorCount, 3);

      const rootDir = store.get(rootUri);
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
      store.set(fileA, status(ProblemSeverity.Error));
      store.set(fileB, status(ProblemSeverity.Warning));

      const changed = manager.rebuildAll();

      assert.ok(changed.length > 0);

      const rootDir = store.get(rootUri);
      assert.strictEqual(rootDir?.severity, ProblemSeverity.Error);
    });

    test('empty cache produces no changes', () => {
      const changed = manager.rebuildAll();
      assert.strictEqual(changed.length, 0);
    });

    test('reads latest workspaceFolders (not stale snapshot)', () => {
      const mutableFolders: Uri[] = [];
      const dynamicWf: FolderWorkspace = {
        get workspaceFolders() {
          return mutableFolders.map((uri, index) => ({
            uri,
            name: uri.path.split('/').filter(Boolean).pop() ?? 'root',
            index,
          }));
        },
        getWorkspaceFolder: (uri: Uri) => {
          const str = uri.toString();
          for (const f of mutableFolders) {
            const fStr = f.toString();
            if (str === fStr || str.startsWith(fStr + '/')) {
              return { uri: f, name: f.path.split('/').filter(Boolean).pop() ?? 'root', index: 0 };
            }
          }
          return undefined;
        },
      };
      const dynamicManager = new FolderStatusManager(store, dynamicWf);

      // No folders initially — rebuildAll should produce nothing
      assert.strictEqual(dynamicManager.rebuildAll().length, 0);

      // Add a folder and a cached file under it
      mutableFolders.push(rootUri);
      store.set(fileA, status(ProblemSeverity.Error));

      // rebuildAll must see the newly added folder
      const changed = dynamicManager.rebuildAll();
      assert.ok(changed.length > 0, 'should detect changes when folders appear after construction');
      const rootDir = store.get(rootUri);
      assert.strictEqual(rootDir?.severity, ProblemSeverity.Error);
    });
  });

  suite('aggregation (worst-severity-wins)', () => {
    test('Error beats Warning', () => {
      store.set(fileA, status(ProblemSeverity.Error));
      store.set(fileB, status(ProblemSeverity.Warning));
      const s = manager.recomputeFolderStatus(rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Error);
    });

    test('Warning beats Info', () => {
      store.set(fileA, status(ProblemSeverity.Warning));
      store.set(fileB, status(ProblemSeverity.Info));
      const s = manager.recomputeFolderStatus(rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Warning);
    });

    test('Info beats None', () => {
      store.set(fileA, status(ProblemSeverity.Info));
      store.set(fileB, status(ProblemSeverity.None));
      const s = manager.recomputeFolderStatus(rootUri);
      assert.strictEqual(s.severity, ProblemSeverity.Info);
    });
  });
});
