import * as assert from 'assert';
import { Uri, ThemeColor } from 'vscode';
import { ProblemCache } from '../../cache/cacheLayer';
import { ProblemStore } from '../../store/ProblemStore';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { ProblemSeverity, ProblemState } from '../../core/types';
import { COLORS, BADGE_LETTERS } from '../../core/constants';

suite('DecorationEngine', () => {
  const fileUri = Uri.parse('file:///workspace/src/file.ts');

  function s(severity: ProblemSeverity, overrides?: Partial<ProblemState>): ProblemState {
    return {
      severity,
      errorCount: overrides?.errorCount ?? (severity === ProblemSeverity.Error ? 1 : 0),
      warningCount: overrides?.warningCount ?? (severity === ProblemSeverity.Warning ? 1 : 0),
      infoCount: overrides?.infoCount ?? (severity === ProblemSeverity.Info ? 1 : 0),
      fileCount: overrides?.fileCount ?? (severity !== ProblemSeverity.None ? 1 : 0),
    };
  }

  let cache: ProblemCache;
  let store: ProblemStore;
  let engine: DecorationEngine;

  setup(() => {
    cache = new ProblemCache();
    store = new ProblemStore();
    engine = new DecorationEngine(cache, store);
  });

  test('provideFileDecoration returns undefined for file outside workspace', () => {
    const outside = Uri.parse('file:///outside/file.ts');
    const result = engine.provideFileDecoration(outside, {} as any);
    assert.strictEqual(result, undefined);
  });

  test('provideFileDecoration returns decoration for cached error file', () => {
    store.set(fileUri, s(ProblemSeverity.Error));
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result);
    assert.strictEqual(result.badge, BADGE_LETTERS.error);
    assert.ok(result.color instanceof ThemeColor);
    assert.strictEqual(result.color.id, COLORS.ERROR_FOREGROUND);
  });

  test('provideFileDecoration returns decoration for cached warning file', () => {
    store.set(fileUri, s(ProblemSeverity.Warning));
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result);
    assert.strictEqual(result.badge, BADGE_LETTERS.warning);
    assert.strictEqual(result.color!.id, COLORS.WARNING_FOREGROUND);
  });

  test('provideFileDecoration returns decoration for cached info file', () => {
    store.set(fileUri, s(ProblemSeverity.Info));
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result);
    assert.strictEqual(result.badge, BADGE_LETTERS.info);
    assert.strictEqual(result.color!.id, COLORS.INFO_FOREGROUND);
  });

  test('provideFileDecoration returns undefined for clean file', () => {
    store.set(fileUri, s(ProblemSeverity.None));
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.strictEqual(result, undefined);
  });

  test('provideFileDecoration returns undefined for uncached file with no diagnostics', () => {
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.strictEqual(result, undefined);
  });

  test('tooltip formats single error', () => {
    store.set(fileUri, s(ProblemSeverity.Error, { errorCount: 1 }));
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result?.tooltip?.includes('1 error'));
  });

  test('tooltip formats plural counts', () => {
    store.set(
      fileUri,
      s(ProblemSeverity.Error, { errorCount: 3, warningCount: 2, infoCount: 5 }),
    );
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result?.tooltip?.includes('3 errors'));
    assert.ok(result?.tooltip?.includes('2 warnings'));
    assert.ok(result?.tooltip?.includes('5 info'));
  });

  test('tooltip shows across N files for folder-like status with fileCount > 1', () => {
    const folderUri = Uri.parse('file:///workspace/src');
    store.set(
      folderUri,
      s(ProblemSeverity.Error, { errorCount: 3, warningCount: 2, fileCount: 5 }),
    );
    const result = engine.provideFileDecoration(folderUri, {} as any);
    assert.ok(result?.tooltip?.includes('across 5 files'));
  });

  test('tooltip does not show across N files for single file', () => {
    store.set(fileUri, s(ProblemSeverity.Error, { errorCount: 1, fileCount: 1 }));
    const result = engine.provideFileDecoration(fileUri, {} as any);
    assert.ok(result?.tooltip?.includes('1 error'));
    assert.ok(!result?.tooltip?.includes('across'));
  });

  test('propagate is false', () => {
    store.set(fileUri, s(ProblemSeverity.Error));
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
