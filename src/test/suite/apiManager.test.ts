import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ApiManager, WorkspaceFolderDelegate, ProblemStateChangeEvent } from '../../api/problemExplorerApi';
import { ProblemSeverity, ProblemState } from '../../core/types';

suite('ApiManager', () => {
  const rootUri = Uri.parse('file:///workspace');
  const fileUri = Uri.parse('file:///workspace/src/file.ts');

  function makeMockWorkspace(): WorkspaceFolderDelegate {
    return {
      getWorkspaceFolder: (uri) => {
        const str = uri.toString();
        if (str === rootUri.toString() || str.startsWith(rootUri.toString() + '/')) {
          return { uri: rootUri, name: 'workspace', index: 0 };
        }
        return undefined;
      },
    };
  }

  function s(severity: ProblemSeverity, overrides?: Partial<ProblemState>): ProblemState {
    return {
      severity,
      errorCount: overrides?.errorCount ?? (severity === ProblemSeverity.Error ? 1 : 0),
      warningCount: overrides?.warningCount ?? (severity === ProblemSeverity.Warning ? 1 : 0),
      infoCount: overrides?.infoCount ?? (severity === ProblemSeverity.Info ? 1 : 0),
      fileCount: overrides?.fileCount ?? (severity !== ProblemSeverity.None ? 1 : 0),
    };
  }

  const errorStatus = s(ProblemSeverity.Error);

  let store: ProblemStore;
  let wf: WorkspaceFolderDelegate;
  let api: ApiManager;

  setup(() => {
    store = new ProblemStore();
    wf = makeMockWorkspace();
    api = new ApiManager(store, wf);
  });

  suite('getProblemState', () => {
    test('returns undefined for URI outside workspace', () => {
      const outside = Uri.parse('file:///outside/file.ts');
      assert.strictEqual(api.getProblemState(outside), undefined);
    });

    test('returns undefined for un-cached URI', () => {
      assert.strictEqual(api.getProblemState(fileUri), undefined);
    });

    test('returns status from cache for cached URI', () => {
      store.set(fileUri, errorStatus);
      const result = api.getProblemState(fileUri);
      assert.deepStrictEqual(result, errorStatus);
    });

    test('returns undefined after cache entry is deleted', () => {
      store.set(fileUri, errorStatus);
      store.delete(fileUri);
      assert.strictEqual(api.getProblemState(fileUri), undefined);
    });

    test('resolves workspace folder correctly', () => {
      const subFile = Uri.parse('file:///workspace/sub/file.ts');
      store.set(subFile, errorStatus);
      assert.deepStrictEqual(api.getProblemState(subFile), errorStatus);
    });
  });

  suite('onDidChangeProblemState', () => {
    test('fires event with status when notifyChanged is called', () => {
      const folderUri = wf.getWorkspaceFolder(fileUri)!.uri;
      store.set(fileUri, errorStatus);

      const events: ProblemStateChangeEvent[] = [];
      const disposable = api.onDidChangeProblemState((e) => events.push(e));
      try {
        api.notifyChanged(fileUri, folderUri);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].uri.toString(), fileUri.toString());
        assert.deepStrictEqual(events[0].status, errorStatus);
      } finally {
        disposable.dispose();
      }
    });

    test('fires event with undefined status for deleted entry', () => {
      const folderUri = wf.getWorkspaceFolder(fileUri)!.uri;
      store.set(fileUri, errorStatus);
      store.delete(fileUri);

      const events: ProblemStateChangeEvent[] = [];
      const disposable = api.onDidChangeProblemState((e) => events.push(e));
      try {
        api.notifyChanged(fileUri, folderUri);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].uri.toString(), fileUri.toString());
        assert.strictEqual(events[0].status, undefined);
      } finally {
        disposable.dispose();
      }
    });

    test('fires multiple events for different URIs', () => {
      const file2 = Uri.parse('file:///workspace/src/file2.ts');
      const folderUri = wf.getWorkspaceFolder(fileUri)!.uri;
      store.set(fileUri, errorStatus);
      store.set(file2, s(ProblemSeverity.Warning));

      const events: ProblemStateChangeEvent[] = [];
      const disposable = api.onDidChangeProblemState((e) => events.push(e));
      try {
        api.notifyChanged(fileUri, folderUri);
        api.notifyChanged(file2, folderUri);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].status?.severity, ProblemSeverity.Error);
        assert.strictEqual(events[1].status?.severity, ProblemSeverity.Warning);
      } finally {
        disposable.dispose();
      }
    });

    test('disposable stops receiving events', () => {
      const folderUri = wf.getWorkspaceFolder(fileUri)!.uri;

      const events: ProblemStateChangeEvent[] = [];
      const disposable = api.onDidChangeProblemState((e) => events.push(e));
      disposable.dispose();
      api.notifyChanged(fileUri, folderUri);
      assert.strictEqual(events.length, 0);
    });
  });
});
