import * as assert from 'assert';
import { Uri, WorkspaceFolder } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
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

  test('getWorkspaceFolders returns initial folders', () => {
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache);
    const fm = new FolderStatusManager(cache);
    const de = new DecorationEngine(cache);
    const { delegate } = makeMockDelegate([rootA, rootB]);
    const wm = new WorkspaceManager(cache, dm, fm, de, delegate);

    const folders = wm.getWorkspaceFolders();
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders[0].uri.toString(), rootA.toString());
    assert.strictEqual(folders[1].uri.toString(), rootB.toString());
  });

  test('returns empty array when no folders', () => {
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache);
    const fm = new FolderStatusManager(cache);
    const de = new DecorationEngine(cache);
    const { delegate } = makeMockDelegate([]);
    const wm = new WorkspaceManager(cache, dm, fm, de, delegate);

    assert.strictEqual(wm.getWorkspaceFolders().length, 0);
  });

  test('clears cache for removed folder', () => {
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache);
    const fm = new FolderStatusManager(cache);
    const de = new DecorationEngine(cache);
    const { delegate, listeners } = makeMockDelegate([rootA, rootB]);

    cache.set(fileA, { severity: 3, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, rootA);
    assert.strictEqual(cache.getFolderSize(rootA), 1);

    new WorkspaceManager(cache, dm, fm, de, delegate);
    const removed = [makeFolder(rootB, 1)];
    listeners[0]({ added: [], removed } as WorkspaceFoldersChangeEvent);

    assert.strictEqual(cache.getFolderSize(rootA), 1);
  });

  test('clears correct folder on multi-root removal', () => {
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache);
    const fm = new FolderStatusManager(cache);
    const de = new DecorationEngine(cache);
    const { delegate, listeners } = makeMockDelegate([rootA, rootB]);

    cache.set(fileA, { severity: 3, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, rootA);
    cache.set(Uri.parse('file:///workspace/b/other.ts'), { severity: 3, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, rootB);
    assert.strictEqual(cache.getFolderSize(rootA), 1);
    assert.strictEqual(cache.getFolderSize(rootB), 1);

    new WorkspaceManager(cache, dm, fm, de, delegate);
    listeners[0]({ added: [], removed: [makeFolder(rootB, 1)] } as WorkspaceFoldersChangeEvent);

    assert.strictEqual(cache.getFolderSize(rootA), 1);
    assert.strictEqual(cache.getFolderSize(rootB), 0);
  });

  test('on folder added runs fullScan', () => {
    const cache = new ProblemCache();
    const dm = new DiagnosticsManager(cache);
    const fm = new FolderStatusManager(cache);
    const de = new DecorationEngine(cache);

    let fullScanCalled = false;
    const originalFullScan = dm.fullScan.bind(dm);
    dm.fullScan = () => {
      fullScanCalled = true;
      return originalFullScan();
    };

    const { delegate, listeners } = makeMockDelegate([]);
    new WorkspaceManager(cache, dm, fm, de, delegate);

    listeners[0]({
      added: [makeFolder(rootA, 0)],
      removed: [],
    } as WorkspaceFoldersChangeEvent);

    assert.strictEqual(fullScanCalled, true);
  });
});
