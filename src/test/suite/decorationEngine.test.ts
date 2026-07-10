import * as assert from 'assert';
import { Uri, ThemeColor } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { DecorationEngine, WorkspaceFolderDelegate } from '../../decoration/decorationEngine';
import { ProblemSeverity, ProblemStatus } from '../../core/types';
import { COLORS, BADGE_LETTERS } from '../../core/constants';

suite('DecorationEngine', () => {
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

  function s(severity: ProblemSeverity, overrides?: Partial<ProblemStatus>): ProblemStatus {
    return {
      severity,
      errorCount: overrides?.errorCount ?? (severity === ProblemSeverity.Error ? 1 : 0),
      warningCount: overrides?.warningCount ?? (severity === ProblemSeverity.Warning ? 1 : 0),
      infoCount: overrides?.infoCount ?? (severity === ProblemSeverity.Info ? 1 : 0),
      fileCount: overrides?.fileCount ?? (severity !== ProblemSeverity.None ? 1 : 0),
    };
  }

  let cache: ProblemCache;
  let wf: WorkspaceFolderDelegate;
  let engine: DecorationEngine;

  setup(() => {
    cache = new ProblemCache();
    wf = makeMockWorkspace();
    engine = new DecorationEngine(cache, wf);
  });

  test('provideFileDecoration returns undefined for file outside workspace', () => {
    const outside = Uri.parse('file:///outside/file.ts');
    const result = engine.provideFileDecoration(outside, {} as any);
    assert.strictEqual(result, undefined);
  });

  test('provideFileDecoration returns decoration for cached error file', () => {
    cache.set(fileUri, s(ProblemSeverity.Error), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result);
    assert.strictEqual(result.badge, BADGE_LETTERS.error);
    assert.ok(result.color instanceof ThemeColor);
    assert.strictEqual(result.color.id, COLORS.ERROR_FOREGROUND);
  });

  test('provideFileDecoration returns decoration for cached warning file', () => {
    cache.set(fileUri, s(ProblemSeverity.Warning), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result);
    assert.strictEqual(result.badge, BADGE_LETTERS.warning);
    assert.strictEqual(result.color!.id, COLORS.WARNING_FOREGROUND);
  });

  test('provideFileDecoration returns decoration for cached info file', () => {
    cache.set(fileUri, s(ProblemSeverity.Info), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result);
    assert.strictEqual(result.badge, BADGE_LETTERS.info);
    assert.strictEqual(result.color!.id, COLORS.INFO_FOREGROUND);
  });

  test('provideFileDecoration returns undefined for clean file', () => {
    cache.set(fileUri, s(ProblemSeverity.None), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.strictEqual(result, undefined);
  });

  test('provideFileDecoration returns undefined for uncached file with no diagnostics', () => {
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.strictEqual(result, undefined);
  });

  test('tooltip formats single error', () => {
    cache.set(fileUri, s(ProblemSeverity.Error, { errorCount: 1 }), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result?.tooltip?.includes('1 error'));
  });

  test('tooltip formats plural counts', () => {
    cache.set(
      fileUri,
      s(ProblemSeverity.Error, { errorCount: 3, warningCount: 2, infoCount: 5 }),
      rootUri,
    );
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result?.tooltip?.includes('3 errors'));
    assert.ok(result?.tooltip?.includes('2 warnings'));
    assert.ok(result?.tooltip?.includes('5 info'));
  });

  test('tooltip shows across N files for folder-like status with fileCount > 1', () => {
    const folderUri = Uri.parse('file:///workspace/src');
    cache.set(
      folderUri,
      s(ProblemSeverity.Error, { errorCount: 3, warningCount: 2, fileCount: 5 }),
      rootUri,
    );
    const result = engine.provideFileDecoration(folderUri, {} as any);
    assert.ok(result?.tooltip?.includes('across 5 files'));
  });

  test('tooltip does not show across N files for single file', () => {
    cache.set(fileUri, s(ProblemSeverity.Error, { errorCount: 1, fileCount: 1 }), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result?.tooltip?.includes('1 error'));
    assert.ok(!result?.tooltip?.includes('across'));
  });

  test('propagate is false', () => {
    cache.set(fileUri, s(ProblemSeverity.Error), rootUri);
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.strictEqual(result?.propagate, false);
  });

  test('fireDidChange triggers onDidChangeFileDecorations', () => {
    const uris: unknown[] = [];
    engine.onDidChangeFileDecorations((e) => uris.push(e));
    engine.fireDidChange([fileUri]);
    assert.strictEqual(uris.length, 1);
    assert.deepStrictEqual(uris[0], [fileUri]);
  });

  test('refresh fires with undefined', () => {
    const values: unknown[] = [];
    engine.onDidChangeFileDecorations((e) => values.push(e));
    engine.refresh();
    assert.strictEqual(values.length, 1);
    assert.strictEqual(values[0], undefined);
  });

  test('fireDidChange with undefined', () => {
    const values: unknown[] = [];
    engine.onDidChangeFileDecorations((e) => values.push(e));
    engine.fireDidChange(undefined);
    assert.strictEqual(values.length, 1);
    assert.strictEqual(values[0], undefined);
  });
});
