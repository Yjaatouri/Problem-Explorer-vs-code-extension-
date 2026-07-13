import * as assert from 'assert';
import { Uri, Diagnostic, DiagnosticSeverity, Range, Position } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { LruCache } from '../../cache/lruCache';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { DiagnosticsManager } from '../../diagnostics/diagnosticsManager';
import { aggregateStatuses } from '../../folder/propagationStrategy';
import { ProblemSeverity, ProblemStatus } from '../../core/types';
import { measure, formatResult } from '../../benchmark/benchmark';

suite('Benchmarks', function () {
  this.slow(5000);
  this.timeout(30000);

  const rootUri = Uri.parse('file:///workspace');

  function mockWorkspaceFolder(uri: Uri) {
    const str = uri.toString();
    if (str.startsWith(rootUri.toString())) {
      return { uri: rootUri, name: 'workspace', index: 0 };
    }
    return undefined;
  }

  function makeDiag(severity: DiagnosticSeverity): Diagnostic {
    return new Diagnostic(new Range(new Position(0, 0), new Position(0, 1)), 't', severity);
  }

  test('provideFileDecoration lookup < 1µs (target)', () => {
    const cache = new ProblemCache();
    const engine = new DecorationEngine(cache);

    const fileUri = Uri.parse('file:///workspace/src/file.ts');
    cache.set(fileUri, { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, rootUri);

    const result = measure('provideFileDecoration', () => {
      engine.provideFileDecoration(fileUri, {} as any);
    }, 100000);

    console.log(formatResult(result));
    assert.ok(result.avgUs < 5, `provideFileDecoration avg ${result.avgUs.toFixed(3)}µs (target < 5µs)`);
  });

  test('fullScan with 10k files < 200ms (target)', () => {
    const cache = new ProblemCache();
    const entries: [Uri, Diagnostic[]][] = [];

    for (let i = 0; i < 10000; i++) {
      const uri = Uri.parse(`file:///workspace/src/file${i}.ts`);
      const diags = [makeDiag(DiagnosticSeverity.Warning)];
      entries.push([uri, diags]);
    }

    const dm = new DiagnosticsManager(cache, {
      getAllDiagnostics: () => entries,
      getUriDiagnostics: () => [],
      getWorkspaceFolder: mockWorkspaceFolder,
      isActiveEditorUri: () => false,
    });

    const result = measure('fullScan (10k files)', () => {
      cache.clear();
      dm.fullScan();
    }, 5);

    console.log(formatResult(result));
    assert.ok(result.totalMs / 5 < 1000, `fullScan avg ${(result.totalMs / 5).toFixed(2)}ms (target < 1000ms)`);
  });

  test('LRU cache get/set at capacity (10k entries)', () => {
    const lru = new LruCache<string, number>(10000);
    for (let i = 0; i < 10000; i++) {
      lru.set(`key${i}`, i);
    }

    const getResult = measure('LRU get (10k entries)', () => {
      for (let i = 0; i < 1000; i++) {
        lru.get(`key${i}`);
      }
    }, 10);

    console.log(formatResult(getResult));

    const setResult = measure('LRU set (10k entries)', () => {
      for (let i = 0; i < 1000; i++) {
        lru.set(`key${i}`, i);
      }
    }, 10);

    console.log(formatResult(setResult));
    assert.ok(setResult.avgUs < 2000, `LRU set avg ${setResult.avgUs.toFixed(3)}µs (target < 2000µs)`);
  });

  test('rapid diagnostic changes (1000 events)', () => {
    const cache = new ProblemCache();
    const diagnostics: [Uri, Diagnostic[]][] = [];
    const allUris: Uri[] = [];

    for (let i = 0; i < 1000; i++) {
      const uri = Uri.parse(`file:///workspace/src/file${i}.ts`);
      allUris.push(uri);
      diagnostics.push([uri, [makeDiag(DiagnosticSeverity.Error)]]);
    }

    const dm = new DiagnosticsManager(cache, {
      getAllDiagnostics: () => diagnostics,
      getUriDiagnostics: (uri: Uri) => {
        const found = diagnostics.find(([u]) => u.toString() === uri.toString());
        return found ? found[1] : [];
      },
      getWorkspaceFolder: mockWorkspaceFolder,
      isActiveEditorUri: () => false,
    });

    const result = measure('processChanges (1000 events)', () => {
      cache.clear();
      for (let i = 0; i < 1000; i++) {
        dm.processChanges({ uris: [allUris[i]] } as any);
      }
    }, 5);

    console.log(formatResult(result));
    const avgMs = result.totalMs / 5;
    assert.ok(avgMs < 500, `1000 rapid changes took ${avgMs.toFixed(2)}ms (target < 500ms)`);
  });

  test('aggregateStatuses performance (10k entries)', () => {
    const children: ProblemStatus[] = [];
    for (let i = 0; i < 10000; i++) {
      children.push({
        severity: i % 3 === 0 ? ProblemSeverity.Error : ProblemSeverity.Warning,
        errorCount: i % 3 === 0 ? 1 : 0,
        warningCount: i % 3 !== 0 ? 1 : 0,
        infoCount: 0,
        fileCount: 1,
      });
    }

    const result = measure('aggregateStatuses (10k)', () => {
      aggregateStatuses(children);
    }, 100);

    console.log(formatResult(result));
    assert.ok(result.avgUs < 500, `aggregateStatuses avg ${result.avgUs.toFixed(3)}µs (target < 500µs)`);
  });

  test('ProblemCache set/get performance at 10k entries', () => {
    const cache = new ProblemCache();
    const fileUris: Uri[] = [];

    for (let i = 0; i < 10000; i++) {
      const uri = Uri.parse(`file:///workspace/src/file${i}.ts`);
      fileUris.push(uri);
    }

    const setResult = measure('cache set (10k unique)', () => {
      for (let i = 0; i < 10000; i++) {
        cache.set(fileUris[i], { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 }, rootUri);
      }
    }, 3);

    console.log(formatResult(setResult));

    const getResult = measure('cache get (10k entries)', () => {
      for (let i = 0; i < 10000; i++) {
        cache.get(fileUris[i], rootUri);
      }
    }, 3);

    console.log(formatResult(getResult));
  });
});
