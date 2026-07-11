import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { LruCache } from '../../cache/lruCache';
import { ProblemStatus, ProblemSeverity } from '../../core/types';
import { aggregateStatuses } from '../../folder/propagationStrategy';
import { toProblemStatus } from '../../diagnostics/severityMapper';

suite('Scenarios', () => {
  const rootUri = Uri.parse('file:///workspace');

  function randomSeverity(): ProblemSeverity {
    const r = Math.random();
    if (r < 0.3) return ProblemSeverity.Error;
    if (r < 0.6) return ProblemSeverity.Warning;
    if (r < 0.85) return ProblemSeverity.Info;
    return ProblemSeverity.None;
  }

  test('1000 files with random diagnostics', () => {
    const cache = new ProblemCache();
    const statuses: ProblemStatus[] = [];

    for (let i = 0; i < 1000; i++) {
      const sev = randomSeverity();
      const s: ProblemStatus = {
        severity: sev,
        errorCount: sev === ProblemSeverity.Error ? Math.floor(Math.random() * 5) + 1 : 0,
        warningCount: sev === ProblemSeverity.Warning ? Math.floor(Math.random() * 5) + 1 : 0,
        infoCount: sev === ProblemSeverity.Info ? Math.floor(Math.random() * 5) + 1 : 0,
        fileCount: sev !== ProblemSeverity.None ? 1 : 0,
      };
      const uri = Uri.parse(`file:///workspace/src/file${i}.ts`);
      cache.set(uri, s, rootUri);
      statuses.push(s);
    }

    const storedCount = statuses.filter((s) => s.severity !== ProblemSeverity.None).length;
    assert.strictEqual(cache.getFolderSize(rootUri), storedCount);

    const aggregated = aggregateStatuses(statuses);
    const expectedSeverity = statuses.reduce(
      (max, s) => (s.severity > max ? s.severity : max),
      ProblemSeverity.None,
    );
    assert.strictEqual(aggregated.severity, expectedSeverity);
  });

  test('LRU eviction with capacity stress', () => {
    const lru = new LruCache<string, number>(100);
    for (let i = 0; i < 1000; i++) {
      lru.set(`key${i}`, i);
    }
    assert.strictEqual(lru.size, 100);
    assert.strictEqual(lru.get('key0'), undefined);
    assert.ok(lru.get('key999') !== undefined);
  });

  test('rapid LRU set and get pattern', () => {
    const lru = new LruCache<string, number>(50);
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 100; i++) {
        lru.set(`k${i}`, i);
        lru.get(`k${i}`);
      }
    }
    assert.strictEqual(lru.size, 50);
    for (let i = 50; i < 100; i++) {
      assert.ok(lru.has(`k${i}`), `key k${i} should exist`);
    }
  });

  test('deeply nested folders (50 levels)', () => {
    const cache = new ProblemCache();
    const parts: string[] = [];
    for (let i = 0; i < 50; i++) {
      parts.push(`a`);
    }
    const deepDir = Uri.parse(`file:///workspace/${parts.join('/')}/file.ts`);
    const status: ProblemStatus = {
      severity: ProblemSeverity.Error,
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
      fileCount: 1,
    };
    cache.set(deepDir, status, rootUri);
    assert.strictEqual(cache.get(deepDir, rootUri)?.severity, ProblemSeverity.Error);
  });

  test('toProblemStatus handles 10000 diagnostics', () => {
    const range = new (require('vscode').Range)(0, 0, 0, 1);
    const diags: import('vscode').Diagnostic[] = [];
    const severities = [
      require('vscode').DiagnosticSeverity.Error,
      require('vscode').DiagnosticSeverity.Warning,
      require('vscode').DiagnosticSeverity.Information,
      require('vscode').DiagnosticSeverity.Hint,
    ];
    for (let i = 0; i < 10000; i++) {
      diags.push(
        new (require('vscode').Diagnostic)(
          range,
          `diag ${i}`,
          severities[i % severities.length],
        ),
      );
    }
    const start = performance.now();
    const result = toProblemStatus(diags);
    const elapsed = performance.now() - start;
    assert.strictEqual(result.severity, ProblemSeverity.Error);
    assert.strictEqual(result.errorCount, 2500);
    assert.strictEqual(result.warningCount, 2500);
    assert.strictEqual(result.infoCount, 2500);
    assert.ok(elapsed < 50, `toProblemStatus took ${elapsed}ms (expected < 50ms)`);
  });
});
