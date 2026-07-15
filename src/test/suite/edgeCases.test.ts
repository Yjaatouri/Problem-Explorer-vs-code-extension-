import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { DiagnosticsManager, DiagnosticsDelegate } from '../../diagnostics/diagnosticsManager';
import { FolderStatusManager, FolderWorkspace } from '../../folder/folderStatusManager';
import { isIgnored } from '../../performance/ignoreFilter';
import { normalizeUriKey } from '../../core/uriKey';
import { ProblemSeverity, ProblemState } from '../../core/types';

suite('EdgeCases', () => {
  const rootUri = Uri.parse('file:///workspace');

  function status(severity: ProblemSeverity): ProblemState {
    return {
      severity,
      errorCount: severity === ProblemSeverity.Error ? 1 : 0,
      warningCount: severity === ProblemSeverity.Warning ? 1 : 0,
      infoCount: severity === ProblemSeverity.Info ? 1 : 0,
      fileCount: severity !== ProblemSeverity.None ? 1 : 0,
    };
  }

  // ── 1. Workspace-less window ──────────────────────────────────

  suite('workspace-less window', () => {
    test('DiagnosticsManager.getStatus returns undefined without workspace folder', () => {
      const delegate: DiagnosticsDelegate = {
        getAllDiagnostics: () => [],
        getUriDiagnostics: () => [],
        getWorkspaceFolder: () => undefined,
        isActiveEditorUri: () => false,
      };
      const mgr = new DiagnosticsManager(new ProblemStore(), delegate);
      const uri = Uri.parse('file:///workspace/src/file.ts');
      assert.strictEqual(mgr.getStatus(uri), undefined);
    });

    test('DecorationEngine.provideFileDecoration returns undefined without workspace folder', () => {
      const engine = new DecorationEngine(new ProblemStore());
      const result = engine.provideFileDecoration(Uri.parse('file:///workspace/file.ts'), {} as any);
      assert.strictEqual(result, undefined);
    });

    test('FolderStatusManager.updateAncestors returns empty without workspace folder', () => {
      const wf: FolderWorkspace = {
        workspaceFolders: [],
        getWorkspaceFolder: () => undefined,
      };
      const mgr = new FolderStatusManager(new ProblemStore(), wf);
      const changed = mgr.updateAncestors(Uri.parse('file:///workspace/file.ts'));
      assert.strictEqual(changed.length, 0);
    });

    test('FolderStatusManager.rebuildAll returns empty with no folders', () => {
      const wf: FolderWorkspace = {
        workspaceFolders: [],
        getWorkspaceFolder: () => undefined,
      };
      const mgr = new FolderStatusManager(new ProblemStore(), wf);
      const changed = mgr.rebuildAll();
      assert.strictEqual(changed.length, 0);
    });
  });

  // ── 2. Non-ASCII / Unicode paths ─────────────────────────────

  suite('unicode paths', () => {
    test('Chinese characters in file path', () => {
      const uri = Uri.parse('file:///workspace/文件夹/file.ts');
      const store = new ProblemStore();
      store.set(uri, status(ProblemSeverity.Error));
      assert.strictEqual(store.get(uri)?.severity, ProblemSeverity.Error);
    });

    test('Japanese characters in file path', () => {
      const uri = Uri.parse('file:///workspace/プロジェクト/file.ts');
      const store = new ProblemStore();
      store.set(uri, status(ProblemSeverity.Error));
      assert.strictEqual(store.get(uri)?.severity, ProblemSeverity.Error);
    });

    test('Emoji in file path', () => {
      const uri = Uri.parse('file:///workspace/🎉/file.ts');
      const store = new ProblemStore();
      store.set(uri, status(ProblemSeverity.Error));
      assert.strictEqual(store.get(uri)?.severity, ProblemSeverity.Error);
    });

    test('Accented characters (Cyrillic, umlauts, tilde)', () => {
      const uri = Uri.parse('file:///workspace/déjà_vu_über_cool/ñoño.ts');
      const store = new ProblemStore();
      store.set(uri, status(ProblemSeverity.Error));
      assert.strictEqual(store.get(uri)?.severity, ProblemSeverity.Error);
    });

    test('Ignore filter handles unicode paths (does not crash)', () => {
      const uri = Uri.parse('file:///workspace/😊/node_modules/pkg/index.js');
      assert.strictEqual(isIgnored(uri), true);
      const clean = Uri.parse('file:///workspace/üser/src/main.ts');
      assert.strictEqual(isIgnored(clean), false);
    });

    test('Mixed unicode in folder status propagation', () => {
      const store = new ProblemStore();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(store, wf);
      const child = Uri.parse('file:///workspace/测试/src/file.ts');
      store.set(child, status(ProblemSeverity.Error));
      const changed = mgr.updateAncestors(child);
      assert.ok(changed.length > 0);
    });
  });

  // ── 3. Virtual file systems (scheme != file) ─────────────────

  suite('virtual file systems', () => {
    test('isIgnored returns false for non-file scheme', () => {
      const untitled = Uri.parse('untitled:///Untitled-1.ts');
      assert.strictEqual(isIgnored(untitled), false);
      const vscodeRemote = Uri.parse('vscode-remote://ssh-remote+host/home/user/file.ts');
      assert.strictEqual(isIgnored(vscodeRemote), false);
    });

    test('DecorationEngine returns undefined for non-file URI (no workspace folder matches)', () => {
      const engine = new DecorationEngine(new ProblemStore(), {
        getWorkspaceFolder: () => undefined,
      });
      const result = engine.provideFileDecoration(Uri.parse('untitled:///Untitled-1.ts'), {} as any);
      assert.strictEqual(result, undefined);
    });

  });

  // ── 4. Deleted files ─────────────────────────────────────────

  suite('deleted files', () => {
    test('ProblemStore.delete removes entry', () => {
      const store = new ProblemStore();
      const uri = Uri.parse('file:///workspace/src/file.ts');
      store.set(uri, status(ProblemSeverity.Error));
      assert.ok(store.get(uri));
      store.delete(uri);
      assert.strictEqual(store.get(uri), undefined);
    });

    test('ProblemStore.delete on non-existent entry returns false', () => {
      const store = new ProblemStore();
      const uri = Uri.parse('file:///workspace/file.ts');
      assert.strictEqual(store.delete(uri), false);
    });

    test('ProblemStore.delete then re-set re-creates entry correctly', () => {
      const store = new ProblemStore();
      const uri = Uri.parse('file:///workspace/src/file.ts');
      store.set(uri, status(ProblemSeverity.Error));
      store.delete(uri);
      store.set(uri, status(ProblemSeverity.Warning));
      assert.strictEqual(store.get(uri)?.severity, ProblemSeverity.Warning);
    });

    test('FolderStatusManager recomputes after child deletion', () => {
      const store = new ProblemStore();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(store, wf);
      const fileA = Uri.parse('file:///workspace/src/a.ts');
      const fileB = Uri.parse('file:///workspace/src/b.ts');
      store.set(fileA, status(ProblemSeverity.Error));
      store.set(fileB, status(ProblemSeverity.Warning));
      mgr.updateAncestors(fileA);
      mgr.updateAncestors(fileB);

      assert.strictEqual(store.get(rootUri)?.severity, ProblemSeverity.Error);

      store.delete(fileA);
      mgr.updateAncestors(fileA); // fileA is now missing, root recomputed
      const rootStatus = store.get(rootUri);
      assert.strictEqual(rootStatus?.severity, ProblemSeverity.Warning);
    });
  });

  // ── 6. Folder delete / rename with nested errors ───────────

  suite('folder lifecycle events', () => {
    test('deleteByPrefix removes folder aggregate and all descendants from store', () => {
      const store = new ProblemStore();
      const child = Uri.parse('file:///workspace/src/a/file.ts');
      const sub = Uri.parse('file:///workspace/src/a/sub/file2.ts');
      store.set(child, status(ProblemSeverity.Error));
      store.set(sub, status(ProblemSeverity.Warning));

      store.deleteByPrefix(Uri.parse('file:///workspace/src/a').toString());
      assert.strictEqual(store.get(child), undefined);
      assert.strictEqual(store.get(sub), undefined);
    });

    test('movePrefix followed by updateAncestors produces correct root aggregate', () => {
      const store = new ProblemStore();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(store, wf);
      const oldDir = Uri.parse('file:///workspace/src/a');
      const newDir = Uri.parse('file:///workspace/src/b');
      const fileA = Uri.parse('file:///workspace/src/a/file.ts');
      const fileB = Uri.parse('file:///workspace/src/b/file.ts');

      store.set(fileA, status(ProblemSeverity.Error));
      mgr.updateAncestors(fileA);
      assert.strictEqual(store.get(rootUri)?.severity, ProblemSeverity.Error);

      // Rename the folder using ProblemStore.movePrefix
      store.movePrefix(normalizeUriKey(oldDir), normalizeUriKey(newDir));
      mgr.clearIndexPrefix(oldDir);
      mgr.updateAncestors(fileB);

      const rootStatus = store.get(rootUri);
      assert.strictEqual(rootStatus?.severity, ProblemSeverity.Error);
      assert.strictEqual(rootStatus?.errorCount, 1);
      assert.strictEqual(store.get(fileA), undefined);
      assert.strictEqual(store.get(fileB)?.severity, ProblemSeverity.Error);
    });

    test('movePrefix on file creates correct ancestor aggregate at new location', () => {
      const store = new ProblemStore();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(store, wf);
      const oldFile = Uri.parse('file:///workspace/src/a.ts');
      const newFile = Uri.parse('file:///workspace/src/b.ts');

      store.set(oldFile, status(ProblemSeverity.Error));
      mgr.updateAncestors(oldFile);
      assert.strictEqual(store.get(rootUri)?.errorCount, 1);

      // Rename using ProblemStore.movePrefix
      store.movePrefix(normalizeUriKey(oldFile), normalizeUriKey(newFile));
      mgr.updateAncestors(oldFile);
      mgr.updateAncestors(newFile);

      const rootStatus = store.get(rootUri);
      assert.strictEqual(rootStatus?.severity, ProblemSeverity.Error);
      assert.strictEqual(rootStatus?.errorCount, 1);
      assert.strictEqual(store.get(oldFile), undefined);
      assert.strictEqual(store.get(newFile)?.severity, ProblemSeverity.Error);
    });

    test('delete folder wipes all descendants from ancestor aggregate', () => {
      const store = new ProblemStore();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(store, wf);
      const fileInFolderA = Uri.parse('file:///workspace/src/a/file.ts');

      store.set(fileInFolderA, status(ProblemSeverity.Error));
      mgr.updateAncestors(fileInFolderA);
      assert.strictEqual(store.get(rootUri)?.errorCount, 1);

      // Simulate folder deletion
      store.deleteByPrefix(Uri.parse('file:///workspace/src/a').toString());
      mgr.updateAncestors(fileInFolderA);  // remove from ancestors
      mgr.updateAncestors(Uri.parse('file:///workspace/src/a'));  // remove folder aggregate

      assert.strictEqual(store.get(rootUri), undefined);
    });
  });

  // ── 5. Extremely long file paths ─────────────────────────────

  suite('long file paths', () => {
    test('ProblemStore handles 300-character file path', () => {
      const long = 'a'.repeat(280);
      const uri = Uri.parse(`file:///workspace/${long}/file.ts`);
      const store = new ProblemStore();
      store.set(uri, status(ProblemSeverity.Error));
      assert.strictEqual(store.get(uri)?.severity, ProblemSeverity.Error);
    });

    test('Ignore filter handles long path (does not crash)', () => {
      const long = 'a'.repeat(200);
      const uri = Uri.parse(`file:///workspace/${long}/node_modules/pkg/index.js`);
      assert.strictEqual(isIgnored(uri), true);
    });
  });
});
