import * as assert from 'assert';
import {
  DiagnosticSeverity,
  Diagnostic,
  Range,
  Position,
} from 'vscode';
import { ProblemSeverity } from '../../core/types';
import { toProblemSeverity, toProblemStatus } from '../../diagnostics/severityMapper';

function makeDiagnostic(severity: DiagnosticSeverity): Diagnostic {
  return new Diagnostic(
    new Range(new Position(0, 0), new Position(0, 1)),
    'test diagnostic',
    severity,
  );
}

suite('severityMapper', () => {
  suite('toProblemSeverity', () => {
    test('returns None for empty array', () => {
      assert.strictEqual(toProblemSeverity([]), ProblemSeverity.None);
    });

    test('returns Error for errors', () => {
      const diags = [makeDiagnostic(DiagnosticSeverity.Error)];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.Error);
    });

    test('returns Warning for warnings', () => {
      const diags = [makeDiagnostic(DiagnosticSeverity.Warning)];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.Warning);
    });

    test('returns Info for information', () => {
      const diags = [makeDiagnostic(DiagnosticSeverity.Information)];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.Info);
    });

    test('returns Info for hints', () => {
      const diags = [makeDiagnostic(DiagnosticSeverity.Hint)];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.Info);
    });

    test('returns highest severity in mixed array', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Information),
        makeDiagnostic(DiagnosticSeverity.Error),
        makeDiagnostic(DiagnosticSeverity.Warning),
      ];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.Error);
    });

    test('returns Warning when worst is warning', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Information),
        makeDiagnostic(DiagnosticSeverity.Warning),
      ];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.Warning);
    });
  });

  suite('toProblemStatus', () => {
    test('returns clean status for empty array', () => {
      const result = toProblemStatus([]);
      assert.strictEqual(result.severity, ProblemSeverity.None);
      assert.strictEqual(result.errorCount, 0);
      assert.strictEqual(result.warningCount, 0);
      assert.strictEqual(result.infoCount, 0);
    });

    test('counts errors correctly', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Error),
        makeDiagnostic(DiagnosticSeverity.Error),
        makeDiagnostic(DiagnosticSeverity.Error),
      ];
      const result = toProblemStatus(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Error);
      assert.strictEqual(result.errorCount, 3);
    });

    test('counts warnings correctly', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Warning),
        makeDiagnostic(DiagnosticSeverity.Warning),
      ];
      const result = toProblemStatus(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Warning);
      assert.strictEqual(result.warningCount, 2);
    });

    test('counts infos and hints together', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Information),
        makeDiagnostic(DiagnosticSeverity.Hint),
      ];
      const result = toProblemStatus(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Info);
      assert.strictEqual(result.infoCount, 2);
    });

    test('counts mixed severities separately', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Error),
        makeDiagnostic(DiagnosticSeverity.Error),
        makeDiagnostic(DiagnosticSeverity.Warning),
        makeDiagnostic(DiagnosticSeverity.Warning),
        makeDiagnostic(DiagnosticSeverity.Warning),
        makeDiagnostic(DiagnosticSeverity.Information),
      ];
      const result = toProblemStatus(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Error);
      assert.strictEqual(result.errorCount, 2);
      assert.strictEqual(result.warningCount, 3);
      assert.strictEqual(result.infoCount, 1);
    });

    test('handles large array efficiently', () => {
      const diags: Diagnostic[] = [];
      for (let i = 0; i < 10000; i++) {
        diags.push(makeDiagnostic(DiagnosticSeverity.Warning));
      }
      diags.push(makeDiagnostic(DiagnosticSeverity.Error));
      const result = toProblemStatus(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Error);
      assert.strictEqual(result.errorCount, 1);
      assert.strictEqual(result.warningCount, 10000);
    });

    test('winning severity stays Error after Error seen', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Warning),
        makeDiagnostic(DiagnosticSeverity.Error),
        makeDiagnostic(DiagnosticSeverity.Warning),
      ];
      const result = toProblemStatus(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Error);
    });
  });
});
