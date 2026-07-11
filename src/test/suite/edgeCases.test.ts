import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { LruCache } from '../../cache/lruCache';
import { DecorationEngine, WorkspaceFolderDelegate } from '../../decoration/decorationEngine';
import { DiagnosticsManager, DiagnosticsDelegate } from '../../diagnostics/diagnosticsManager';
import { FolderStatusManager, FolderWorkspace } from '../../folder/folderStatusManager';
import { isIgnored } from '../../performance/ignoreFilter';
import { ProblemSeverity, ProblemStatus } from '../../core/types';

suite('EdgeCases', () => {
  const rootUri = Uri.parse('file:///workspace');

  function status(severity: ProblemSeverity): ProblemStatus {
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
      };
      const mgr = new DiagnosticsManager(new ProblemCache(), delegate);
      const uri = Uri.parse('file:///workspace/src/file.ts');
      assert.strictEqual(mgr.getStatus(uri), undefined);
    });

    test('DecorationEngine.provideFileDecoration returns undefined without workspace folder', () => {
      const wf: WorkspaceFolderDelegate = {
        getWorkspaceFolder: () => undefined,
      };
      const cache = new ProblemCache();
      const engine = new DecorationEngine(cache, wf);
      const result = engine.provideFileDecoration(Uri.parse('file:///workspace/file.ts'), {} as any);
      assert.strictEqual(result, undefined);
    });

    test('FolderStatusManager.updateAncestors returns empty without workspace folder', () => {
      const wf: FolderWorkspace = {
        workspaceFolders: [],
        getWorkspaceFolder: () => undefined,
      };
      const mgr = new FolderStatusManager(new ProblemCache(), wf);
      const changed = mgr.updateAncestors(Uri.parse('file:///workspace/file.ts'));
      assert.strictEqual(changed.length, 0);
    });

    test('FolderStatusManager.rebuildAll returns empty with no folders', () => {
      const wf: FolderWorkspace = {
        workspaceFolders: [],
        getWorkspaceFolder: () => undefined,
      };
      const mgr = new FolderStatusManager(new ProblemCache(), wf);
      const changed = mgr.rebuildAll();
      assert.strictEqual(changed.length, 0);
    });
  });

  // ── 2. Non-ASCII / Unicode paths ─────────────────────────────

  suite('unicode paths', () => {
    test('Chinese characters in file path', () => {
      const uri = Uri.parse('file:///workspace/文件夹/file.ts');
      const cache = new ProblemCache();
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      assert.strictEqual(cache.get(uri, rootUri)?.severity, ProblemSeverity.Error);
    });

    test('Japanese characters in file path', () => {
      const uri = Uri.parse('file:///workspace/プロジェクト/file.ts');
      const cache = new ProblemCache();
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      assert.strictEqual(cache.get(uri, rootUri)?.severity, ProblemSeverity.Error);
    });

    test('Emoji in file path', () => {
      const uri = Uri.parse('file:///workspace/🎉/file.ts');
      const cache = new ProblemCache();
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      assert.strictEqual(cache.get(uri, rootUri)?.severity, ProblemSeverity.Error);
    });

    test('Accented characters (Cyrillic, umlauts, tilde)', () => {
      const uri = Uri.parse('file:///workspace/déjà_vu_über_cool/ñoño.ts');
      const cache = new ProblemCache();
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      assert.strictEqual(cache.get(uri, rootUri)?.severity, ProblemSeverity.Error);
    });

    test('Ignore filter handles unicode paths (does not crash)', () => {
      const uri = Uri.parse('file:///workspace/😊/node_modules/pkg/index.js');
      assert.strictEqual(isIgnored(uri), true);
      const clean = Uri.parse('file:///workspace/üser/src/main.ts');
      assert.strictEqual(isIgnored(clean), false);
    });

    test('Mixed unicode in folder status propagation', () => {
      const cache = new ProblemCache();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(cache, wf);
      const child = Uri.parse('file:///workspace/测试/src/file.ts');
      cache.set(child, status(ProblemSeverity.Error), rootUri);
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
      const wf: WorkspaceFolderDelegate = {
        getWorkspaceFolder: () => undefined,
      };
      const engine = new DecorationEngine(new ProblemCache(), wf);
      const result = engine.provideFileDecoration(Uri.parse('untitled:///Untitled-1.ts'), {} as any);
      assert.strictEqual(result, undefined);
    });

    test('LruCache accepts non-file URI keys', () => {
      const lru = new LruCache<string, number>(10);
      const key = 'untitled:///Untitled-1';
      lru.set(key, 42);
      assert.strictEqual(lru.get(key), 42);
      assert.strictEqual(lru.get('file:///other'), undefined);
    });
  });

  // ── 4. Deleted files ─────────────────────────────────────────

  suite('deleted files', () => {
    test('ProblemCache.delete removes entry', () => {
      const cache = new ProblemCache();
      const uri = Uri.parse('file:///workspace/src/file.ts');
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      assert.ok(cache.get(uri, rootUri));
      cache.delete(uri, rootUri);
      assert.strictEqual(cache.get(uri, rootUri), undefined);
    });

    test('LruCache.delete removes entry and updates size', () => {
      const lru = new LruCache<string, number>(10);
      lru.set('a', 1);
      lru.set('b', 2);
      assert.strictEqual(lru.size, 2);
      const deleted = lru.delete('a');
      assert.strictEqual(deleted, true);
      assert.strictEqual(lru.size, 1);
      assert.strictEqual(lru.get('a'), undefined);
      assert.strictEqual(lru.get('b'), 2);
    });

    test('LruCache.delete returns false for missing key', () => {
      const lru = new LruCache<string, number>(10);
      assert.strictEqual(lru.delete('does-not-exist'), false);
    });

    test('ProblemCache.delete on non-existent folder does not throw', () => {
      const cache = new ProblemCache();
      const uri = Uri.parse('file:///workspace/file.ts');
      const folder = Uri.parse('file:///nonexistent');
      cache.delete(uri, folder);
    });

    test('ProblemCache.delete then re-set re-creates entry correctly', () => {
      const cache = new ProblemCache();
      const uri = Uri.parse('file:///workspace/src/file.ts');
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      cache.delete(uri, rootUri);
      cache.set(uri, status(ProblemSeverity.Warning), rootUri);
      assert.strictEqual(cache.get(uri, rootUri)?.severity, ProblemSeverity.Warning);
    });

    test('FolderStatusManager recomputes after child deletion', () => {
      const cache = new ProblemCache();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(cache, wf);
      const fileA = Uri.parse('file:///workspace/src/a.ts');
      const fileB = Uri.parse('file:///workspace/src/b.ts');
      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      cache.set(fileB, status(ProblemSeverity.Warning), rootUri);
      mgr.updateAncestors(fileA);
      mgr.updateAncestors(fileB);

      assert.strictEqual(cache.get(rootUri, rootUri)?.severity, ProblemSeverity.Error);

      cache.delete(fileA, rootUri);
      mgr.updateAncestors(fileA); // fileA is now missing, root recomputed
      const rootStatus = cache.get(rootUri, rootUri);
      assert.strictEqual(rootStatus?.severity, ProblemSeverity.Warning);
    });
  });

  // ── 6. Folder delete / rename with nested errors ───────────

  suite('folder lifecycle events', () => {
    test('deletePrefix removes folder aggregate and all descendants from cache', () => {
      const cache = new ProblemCache();
      const child = Uri.parse('file:///workspace/src/a/file.ts');
      const sub = Uri.parse('file:///workspace/src/a/sub/file2.ts');
      cache.set(child, status(ProblemSeverity.Error), rootUri);
      cache.set(sub, status(ProblemSeverity.Warning), rootUri);

      cache.deletePrefix(Uri.parse('file:///workspace/src/a'), rootUri);
      assert.strictEqual(cache.get(child, rootUri), undefined);
      assert.strictEqual(cache.get(sub, rootUri), undefined);
    });

    test('movePrefix followed by updateAncestors produces correct root aggregate', () => {
      const cache = new ProblemCache();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(cache, wf);
      const oldDir = Uri.parse('file:///workspace/src/a');
      const newDir = Uri.parse('file:///workspace/src/b');
      const fileA = Uri.parse('file:///workspace/src/a/file.ts');

      cache.set(fileA, status(ProblemSeverity.Error), rootUri);
      mgr.updateAncestors(fileA);
      assert.strictEqual(cache.get(rootUri, rootUri)?.severity, ProblemSeverity.Error);

      // Rename the folder
      cache.movePrefix(oldDir, newDir, rootUri);
      mgr.clearIndexPrefix(oldDir);
      mgr.updateAncestors(oldDir);  // remove old from index
      mgr.updateAncestors(newDir);  // add new to index

      const rootStatus = cache.get(rootUri, rootUri);
      assert.strictEqual(rootStatus?.severity, ProblemSeverity.Error);
      assert.strictEqual(rootStatus?.errorCount, 1);
    });

    test('movePrefix on file creates correct ancestor aggregate at new location', () => {
      const cache = new ProblemCache();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(cache, wf);
      const oldFile = Uri.parse('file:///workspace/src/a.ts');
      const newFile = Uri.parse('file:///workspace/src/b.ts');

      cache.set(oldFile, status(ProblemSeverity.Error), rootUri);
      mgr.updateAncestors(oldFile);
      assert.strictEqual(cache.get(rootUri, rootUri)?.errorCount, 1);

      cache.movePrefix(oldFile, newFile, rootUri);
      mgr.updateAncestors(oldFile);
      mgr.updateAncestors(newFile);

      const rootStatus = cache.get(rootUri, rootUri);
      assert.strictEqual(rootStatus?.severity, ProblemSeverity.Error);
      assert.strictEqual(rootStatus?.errorCount, 1);
    });

    test('delete folder wipes all descendants from ancestor aggregate', () => {
      const cache = new ProblemCache();
      const wf: FolderWorkspace = {
        workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
        getWorkspaceFolder: (u) =>
          u.toString().startsWith(rootUri.toString() + '/')
            ? { uri: rootUri, name: 'workspace', index: 0 }
            : undefined,
      };
      const mgr = new FolderStatusManager(cache, wf);
      const fileInFolderA = Uri.parse('file:///workspace/src/a/file.ts');

      cache.set(fileInFolderA, status(ProblemSeverity.Error), rootUri);
      mgr.updateAncestors(fileInFolderA);
      assert.strictEqual(cache.get(rootUri, rootUri)?.errorCount, 1);

      // Simulate folder deletion
      cache.delete(Uri.parse('file:///workspace/src/a'), rootUri);   // remove exact
      cache.deletePrefix(Uri.parse('file:///workspace/src/a'), rootUri); // remove descendants
      mgr.updateAncestors(fileInFolderA);  // remove from ancestors
      mgr.updateAncestors(Uri.parse('file:///workspace/src/a'));  // remove folder aggregate

      assert.strictEqual(cache.get(rootUri, rootUri), undefined);
    });
  });

  // ── 5. Extremely long file paths ─────────────────────────────

  suite('long file paths', () => {
    test('ProblemCache handles 300-character file path', () => {
      const long = 'a'.repeat(280);
      const uri = Uri.parse(`file:///workspace/${long}/file.ts`);
      const cache = new ProblemCache();
      cache.set(uri, status(ProblemSeverity.Error), rootUri);
      assert.strictEqual(cache.get(uri, rootUri)?.severity, ProblemSeverity.Error);
    });

    test('LruCache handles long string keys', () => {
      const lru = new LruCache<string, number>(10);
      const longKey = 'a'.repeat(5000);
      lru.set(longKey, 1);
      assert.strictEqual(lru.get(longKey), 1);
    });

    test('Ignore filter handles long path (does not crash)', () => {
      const long = 'a'.repeat(200);
      const uri = Uri.parse(`file:///workspace/${long}/node_modules/pkg/index.js`);
      assert.strictEqual(isIgnored(uri), true);
    });
  });
});
