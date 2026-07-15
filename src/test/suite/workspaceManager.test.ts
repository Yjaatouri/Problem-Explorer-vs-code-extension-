import * as assert from 'assert';
import { Uri, WorkspaceFolder } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticsManager } from '../../diagnostics/diagnosticsManager';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { DecorationEngine } from '../../decoration/decorationEngine';
import {
  WorkspaceManager,
  WorkspaceDelegate,
  WorkspaceFoldersChangeEvent,
} from '../../workspace/workspaceManager';

suite('WorkspaceManager', () => {
  const rootA = Uri.parse('file:///workspace/a');
  const rootB = Uri.parse('file:///workspace/b');
  const fileA = Uri.parse('file:///workspace/a/src/file.ts');

  function makeFolder(uri: Uri, index: number): WorkspaceFolder {
    return {
      uri,
      name: uri.path.split('/').filter(Boolean).pop() ?? 'root',
      index,
    };
  }

function makeMockDelegate(
    initialFolders: Uri[],
  ): {
    delegate: WorkspaceDelegate;
    folders: Uri[];
    listeners: Array<(e: WorkspaceFoldersChangeEvent) => void>;
  } {
    const folders = [...initialFolders];
    const listeners: Array<(e: WorkspaceFoldersChangeEvent) => void> = [];

    return {
      folders,
      listeners,
      delegate: {
        get workspaceFolders(): WorkspaceFolder[] {
          return folders.map((uri, i) => makeFolder(uri, i));
        },
        onDidChangeWorkspaceFolders: (listener) => {
          listeners.push(listener);
          return { dispose: () => {} };
        },
      } as WorkspaceDelegate,
    };
  }

  function makeDecorationEngine(
    store: ProblemStore,
    folders: Uri[],
  ): DecorationEngine {
    return new DecorationEngine(store, {
      getWorkspaceFolder: (uri) => {
        for (const folder of folders) {
          if (uri.toString().startsWith(folder.toString())) {
            return { uri: folder, name: folder.path.split('/').pop() ?? 'root', index: 0 };
          }
        }
        return undefined;
      },
    });
  }

  test('getWorkspaceFolders returns initial folders', () => {
    const store = new ProblemStore();
    const dm = new DiagnosticsManager(new ProblemCache(), store);
    const fm = new FolderStatusManager(store);
    const de = makeDecorationEngine(store, [rootA, rootB]);
    const { delegate } = makeMockDelegate([rootA, rootB]);
    const wm = new WorkspaceManager(store, dm, fm, de, delegate);

    const folders = wm.getWorkspaceFolders();
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders[0].uri.toString(), rootA.toString());
    assert.strictEqual(folders[1].uri.toString(), rootB.toString());
  });

  test('returns empty array when no folders', () => {
    const store = new ProblemStore();
    const dm = new DiagnosticsManager(new ProblemCache(), store);
    const fm = new FolderStatusManager(store);
    const de = makeDecorationEngine(store, []);
    const { delegate } = makeMockDelegate([]);
    const wm = new WorkspaceManager(store, dm, fm, de, delegate);

    assert.strictEqual(wm.getWorkspaceFolders().length, 0);
  });

  test('clears store for removed folder', () => {
    const store = new ProblemStore();
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache, store);
    const fm = new FolderStatusManager(store);
    const de = makeDecorationEngine(store, [rootA, rootB]);
    const { delegate, listeners } = makeMockDelegate([rootA, rootB]);

    store.set(fileA, { severity: 3, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 });
    assert.strictEqual(store.get(fileA)?.severity, 3);

    new WorkspaceManager(store, dm, fm, de, delegate);
    const removed = [makeFolder(rootB, 1)];
    listeners[0]({ added: [], removed } as WorkspaceFoldersChangeEvent);

    // The removed folder was rootB, not rootA. RootA entry should remain.
    assert.strictEqual(store.get(fileA)?.severity, 3);
  });

  test('clears correct folder on multi-root removal', () => {
    const store = new ProblemStore();
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache, store);
    const fm = new FolderStatusManager(store);
    const de = makeDecorationEngine(store, [rootA, rootB]);
    const { delegate, listeners } = makeMockDelegate([rootA, rootB]);

    store.set(fileA, { severity: 3, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 });
    store.set(Uri.parse('file:///workspace/b/other.ts'), { severity: 3, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 });
    assert.strictEqual(store.has(fileA), true);
    assert.strictEqual(store.has(Uri.parse('file:///workspace/b/other.ts')), true);

    new WorkspaceManager(store, dm, fm, de, delegate);
    listeners[0]({ added: [], removed: [makeFolder(rootB, 1)] } as WorkspaceFoldersChangeEvent);

    assert.strictEqual(store.has(fileA), true);
    assert.strictEqual(store.has(Uri.parse('file:///workspace/b/other.ts')), false);
  });

  test('on folder added runs fullScan', () => {
    const store = new ProblemStore();
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache, store);
    const fm = new FolderStatusManager(store);
    const de = makeDecorationEngine(store, []);

    let fullScanCalled = false;
    const originalFullScan = dm.fullScan.bind(dm);
    dm.fullScan = () => {
      fullScanCalled = true;
      return originalFullScan();
    };

    const { delegate, listeners } = makeMockDelegate([]);
    new WorkspaceManager(store, dm, fm, de, delegate);

    listeners[0]({
      added: [makeFolder(rootA, 0)],
      removed: [],
    } as WorkspaceFoldersChangeEvent);

    assert.strictEqual(fullScanCalled, true);
  });
});