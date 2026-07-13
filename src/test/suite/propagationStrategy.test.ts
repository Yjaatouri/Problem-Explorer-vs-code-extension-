import * as assert from 'assert';
import { ProblemSeverity, ProblemState } from '../../core/types';
import { aggregateStatuses } from '../../folder/propagationStrategy';

suite('aggregateStatuses', () => {
  function s(severity: ProblemSeverity, overrides?: Partial<ProblemState>): ProblemState {
    return {
      severity,
      errorCount: overrides?.errorCount ?? (severity === ProblemSeverity.Error ? 1 : 0),
      warningCount: overrides?.warningCount ?? (severity === ProblemSeverity.Warning ? 1 : 0),
      infoCount: overrides?.infoCount ?? (severity === ProblemSeverity.Info ? 1 : 0),
      fileCount: overrides?.fileCount ?? (severity !== ProblemSeverity.None ? 1 : 0),
    };
  }

  test('empty array returns None with zero counts', () => {
    const result = aggregateStatuses([]);
    assert.strictEqual(result.severity, ProblemSeverity.None);
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.warningCount, 0);
    assert.strictEqual(result.infoCount, 0);
  });

  test('single Error child', () => {
    const result = aggregateStatuses([s(ProblemSeverity.Error)]);
    assert.strictEqual(result.severity, ProblemSeverity.Error);
    assert.strictEqual(result.errorCount, 1);
    assert.strictEqual(result.fileCount, 1);
  });

  test('single Warning child', () => {
    const result = aggregateStatuses([s(ProblemSeverity.Warning)]);
    assert.strictEqual(result.severity, ProblemSeverity.Warning);
    assert.strictEqual(result.warningCount, 1);
  });

  test('single Info child', () => {
    const result = aggregateStatuses([s(ProblemSeverity.Info)]);
    assert.strictEqual(result.severity, ProblemSeverity.Info);
    assert.strictEqual(result.infoCount, 1);
  });

  test('single None child', () => {
    const result = aggregateStatuses([s(ProblemSeverity.None)]);
    assert.strictEqual(result.severity, ProblemSeverity.None);
  });

  test('Error severity beats Warning', () => {
    const result = aggregateStatuses([
      s(ProblemSeverity.Warning),
      s(ProblemSeverity.Error),
    ]);
    assert.strictEqual(result.severity, ProblemSeverity.Error);
  });

  test('Warning severity beats Info', () => {
    const result = aggregateStatuses([
      s(ProblemSeverity.Info),
      s(ProblemSeverity.Warning),
    ]);
    assert.strictEqual(result.severity, ProblemSeverity.Warning);
  });

  test('Info severity beats None', () => {
    const result = aggregateStatuses([
      s(ProblemSeverity.None),
      s(ProblemSeverity.Info),
    ]);
    assert.strictEqual(result.severity, ProblemSeverity.Info);
  });

  test('counts are summed from all children', () => {
    const result = aggregateStatuses([
      s(ProblemSeverity.Error, { errorCount: 3, warningCount: 1, infoCount: 0 }),
      s(ProblemSeverity.Warning, { errorCount: 0, warningCount: 4, infoCount: 2 }),
      s(ProblemSeverity.Info, { errorCount: 0, warningCount: 0, infoCount: 5 }),
    ]);
    assert.strictEqual(result.errorCount, 3);
    assert.strictEqual(result.warningCount, 5);
    assert.strictEqual(result.infoCount, 7);
    assert.strictEqual(result.severity, ProblemSeverity.Error);
    assert.strictEqual(result.fileCount, 3);
  });

  test('zero-count children contribute zero to sum', () => {
    const result = aggregateStatuses([
      s(ProblemSeverity.None, { errorCount: 0, warningCount: 0, infoCount: 0 }),
      s(ProblemSeverity.None, { errorCount: 0, warningCount: 0, infoCount: 0 }),
    ]);
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.warningCount, 0);
    assert.strictEqual(result.infoCount, 0);
  });

  test('large number of children', () => {
    const children: ProblemState[] = [];
    for (let i = 0; i < 100; i++) {
      children.push(s(ProblemSeverity.Error, { errorCount: 2 }));
    }
    const result = aggregateStatuses(children);
    assert.strictEqual(result.severity, ProblemSeverity.Error);
    assert.strictEqual(result.errorCount, 200);
  });
});
