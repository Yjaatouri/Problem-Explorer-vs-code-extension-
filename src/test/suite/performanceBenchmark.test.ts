import { Uri, WorkspaceFolder } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemState, ProblemSeverity } from '../../core/types';
import { FolderStatusManager, FolderWorkspace } from '../../folder/folderStatusManager';
import { DecorationEngine, DecorationEngineDelegate } from '../../decoration/decorationEngine';
import { measure, formatResult } from '../../benchmark/benchmark';

function state(severity: ProblemSeverity, errorCount = 1): ProblemState {
  return { severity, errorCount, warningCount: 0, infoCount: 0, fileCount: 1 };
}

function makeFile(ws: string, i: number): Uri {
  return Uri.parse(`${ws}/src/pkg/module${i}.ts`);
}

function makeFolder(ws: string, depth: number, i: number): Uri {
  const parts: string[] = [];
  for (let d = 0; d < depth; d++) parts.push(`dir${d}`);
  parts.push(`sub${i}`);
  return Uri.parse(`${ws}/${parts.join('/')}`);
}

function severityFor(i: number): ProblemSeverity {
  if (i % 10 === 0) return ProblemSeverity.Error;
  if (i % 5 === 0) return ProblemSeverity.Warning;
  return ProblemSeverity.Info;
}

function makeMockWorkspace(wsRoot: string): FolderWorkspace {
  const rootUri = Uri.parse(wsRoot);
  const wf: WorkspaceFolder = { uri: rootUri, name: 'root', index: 0 };
  return {
    getWorkspaceFolder: (_uri: Uri) => {
      const s = _uri.toString();
      if (!s.startsWith(wsRoot)) return undefined;
      return wf;
    },
    workspaceFolders: [wf],
  };
}

suite('PerformanceBenchmark', () => {
  const wsRoot = 'file:///workspace';
  const results: string[] = [];

  teardown(() => {
    if (results.length > 0) {
      console.log('=== PERFORMANCE BENCHMARK RESULTS ===');
      for (const r of results) console.log(r);
      console.log('=== END BENCHMARK RESULTS ===');
    }
  });

  test('1a: Insert 1000 diagnostics (individual, no batch)', () => {
    const store = new ProblemStore();
    const r = measure('insert 1000 (individual)', () => {
      for (let i = 0; i < 1000; i++) {
        store.set(makeFile(wsRoot, i), state(severityFor(i)));
      }
    }, 50);
    results.push(formatResult(r));
    store.dispose();
  });

  test('1b: Insert 1000 diagnostics (batched)', () => {
    const store = new ProblemStore();
    const r = measure('insert 1000 (batched)', () => {
      store.beginBatch();
      for (let i = 0; i < 1000; i++) {
        store.set(makeFile(wsRoot, i), state(severityFor(i)));
      }
      store.endBatch();
    }, 50);
    results.push(formatResult(r));
    store.dispose();
  });

  test('2a: Delete 1000 diagnostics (individual)', () => {
    const store = new ProblemStore();
    for (let i = 0; i < 1000; i++) store.set(makeFile(wsRoot, i), state(severityFor(i)));
    const uris = Array.from({ length: 1000 }, (_, i) => makeFile(wsRoot, i));
    const r = measure('delete 1000 (individual)', () => {
      for (const u of uris) store.delete(u);
    }, 50);
    results.push(formatResult(r));
    store.dispose();
  });

  test('2b: Delete by prefix (1000 entries)', () => {
    const store = new ProblemStore();
    for (let i = 0; i < 1000; i++) store.set(makeFile(wsRoot, i), state(severityFor(i)));
    const r = measure('delete 1000 (prefix)', () => {
      store.deleteByPrefix('file:///workspace');
    }, 50);
    results.push(formatResult(r));
    store.dispose();
  });

  test('3: Move prefix (1000 entries)', () => {
    const store = new ProblemStore();
    for (let i = 0; i < 1000; i++) store.set(makeFile(wsRoot, i), state(severityFor(i)));
    const r = measure('move 1000 (prefix)', () => {
      store.movePrefix('file:///workspace/src', 'file:///workspace/lib');
    }, 50);
    results.push(formatResult(r));
    store.dispose();
  });

  test('4a: Folder recomputation — updateAncestors (single file, 5 levels deep)', () => {
    const store = new ProblemStore();
    const wf = makeMockWorkspace(wsRoot);
    const mgr = new FolderStatusManager(store, wf);
    store.set(makeFile(wsRoot, 0), state(ProblemSeverity.Error));
    const deepUri = Uri.parse(`${wsRoot}/a/b/c/d/e/file.ts`);
    store.set(deepUri, state(ProblemSeverity.Error));
    const r = measure('updateAncestors (5-level)', () => {
      mgr.updateAncestors(deepUri);
    }, 200);
    results.push(formatResult(r));
    mgr.rebuildAll();
    store.dispose();
  });

  test('4b: Folder recomputation — updateAncestors (root-level file)', () => {
    const store = new ProblemStore();
    const wf = makeMockWorkspace(wsRoot);
    const mgr = new FolderStatusManager(store, wf);
    store.set(makeFile(wsRoot, 0), state(ProblemSeverity.Error));
    const r = measure('updateAncestors (root-level)', () => {
      mgr.updateAncestors(makeFile(wsRoot, 0));
    }, 200);
    results.push(formatResult(r));
    mgr.rebuildAll();
    store.dispose();
  });

  test('4c: Folder recomputation — rebuildAll (1000 entries, nested folders)', () => {
    const store = new ProblemStore();
    const wf = makeMockWorkspace(wsRoot);
    const mgr = new FolderStatusManager(store, wf);
    for (let i = 0; i < 1000; i++) {
      const uri = makeFolder(wsRoot, 3, i);
      store.set(uri, state(severityFor(i), (i % 10) + 1));
    }
    const r = measure('rebuildAll (1000 entries)', () => {
      mgr.rebuildAll();
    }, 30);
    results.push(formatResult(r));
    store.dispose();
  });

  test('5: Snapshot creation (1000 entries)', () => {
    const store = new ProblemStore();
    for (let i = 0; i < 1000; i++) store.set(makeFile(wsRoot, i), state(severityFor(i)));
    const r = measure('snapshot 1000 entries', () => {
      store.snapshot();
    }, 200);
    results.push(formatResult(r));
    store.dispose();
  });

  test('6a: Decoration lookup — all hits (1000 lookups)', () => {
    const store = new ProblemStore();
    for (let i = 0; i < 1000; i++) store.set(makeFile(wsRoot, i), state(severityFor(i)));
    const delegate: DecorationEngineDelegate = {
      getWorkspaceFolder: () => ({ uri: Uri.parse(wsRoot), name: 'root', index: 0 }),
    };
    const engine = new DecorationEngine(store, delegate);
    const uris = Array.from({ length: 1000 }, (_, i) => makeFile(wsRoot, i));
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const r = measure('decoration 1000 hits', () => {
      for (const u of uris) engine.provideFileDecoration(u, token);
    }, 30);
    results.push(formatResult(r));
    store.dispose();
  });

  test('6b: Decoration lookup — all misses (1000 lookups)', () => {
    const store = new ProblemStore();
    const delegate: DecorationEngineDelegate = {
      getWorkspaceFolder: () => ({ uri: Uri.parse(wsRoot), name: 'root', index: 0 }),
    };
    const engine = new DecorationEngine(store, delegate);
    const uris = Array.from({ length: 1000 }, (_, i) => makeFile(wsRoot, i));
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const r = measure('decoration 1000 misses', () => {
      for (const u of uris) engine.provideFileDecoration(u, token);
    }, 30);
    results.push(formatResult(r));
    store.dispose();
  });

  test('7: computeTotals (1000 entries, mix of files and folder aggregates)', () => {
    const store = new ProblemStore();
    for (let i = 0; i < 1000; i++) store.set(makeFile(wsRoot, i), state(severityFor(i)));
    for (let i = 0; i < 100; i++) {
      store.setFolderAggregate(makeFolder(wsRoot, 2, i), {
        severity: ProblemSeverity.Error, errorCount: i, warningCount: 0, infoCount: 0, fileCount: i,
      });
    }
    const r = measure('computeTotals (1000+100)', () => {
      store.computeTotals();
    }, 500);
    results.push(formatResult(r));
    store.dispose();
  });

  test('8: Mixed workload — insert, updateAncestors, delete in sequence (100 iterations)', () => {
    const store = new ProblemStore();
    const wf = makeMockWorkspace(wsRoot);
    const mgr = new FolderStatusManager(store, wf);
    const delegate: DecorationEngineDelegate = {
      getWorkspaceFolder: () => ({ uri: Uri.parse(wsRoot), name: 'root', index: 0 }),
    };
    const engine = new DecorationEngine(store, delegate);
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

    const r = measure('mixed workload (insert/ancestors/delete)', () => {
      for (let i = 0; i < 100; i++) {
        store.beginBatch();
        for (let j = 0; j < 10; j++) store.set(makeFile(wsRoot, i * 10 + j), state(severityFor(j)));
        store.endBatch();
        mgr.updateAncestors(makeFile(wsRoot, i * 10));
        store.delete(makeFile(wsRoot, i * 10 + 9));
        mgr.updateAncestors(makeFile(wsRoot, i * 10 + 9));
        engine.provideFileDecoration(makeFile(wsRoot, i * 10), token);
      }
    }, 50);
    results.push(formatResult(r));
    store.dispose();
  });
});
