import * as assert from 'assert';
import {
  DiagnosticSeverity,
  Diagnostic,
  Range,
  Position,
  Uri,
} from 'vscode';
import { ProblemSeverity } from '../../core/types';
import { toProblemSeverity, toProblemState, applySeverityOverrides } from '../../diagnostics/severityMapper';

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

    test('returns None for hints (ignored)', () => {
      const diags = [makeDiagnostic(DiagnosticSeverity.Hint)];
      assert.strictEqual(toProblemSeverity(diags), ProblemSeverity.None);
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

  suite('toProblemState', () => {
    test('returns clean status for empty array', () => {
      const result = toProblemState([]);
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
      const result = toProblemState(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Error);
      assert.strictEqual(result.errorCount, 3);
    });

    test('counts warnings correctly', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Warning),
        makeDiagnostic(DiagnosticSeverity.Warning),
      ];
      const result = toProblemState(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Warning);
      assert.strictEqual(result.warningCount, 2);
    });

    test('ignores hints, only counts information', () => {
      const diags = [
        makeDiagnostic(DiagnosticSeverity.Information),
        makeDiagnostic(DiagnosticSeverity.Hint),
      ];
      const result = toProblemState(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Info);
      assert.strictEqual(result.infoCount, 1);
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
      const result = toProblemState(diags);
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
      const result = toProblemState(diags);
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
      const result = toProblemState(diags);
      assert.strictEqual(result.severity, ProblemSeverity.Error);
    });
  });

  suite('applySeverityOverrides', () => {
    function makeError(): Diagnostic {
      return new Diagnostic(new Range(0, 0, 0, 1), 'err', DiagnosticSeverity.Error);
    }
    function makeWarning(): Diagnostic {
      return new Diagnostic(new Range(0, 0, 0, 1), 'warn', DiagnosticSeverity.Warning);
    }
    function makeInfo(): Diagnostic {
      return new Diagnostic(new Range(0, 0, 0, 1), 'info', DiagnosticSeverity.Information);
    }

    const pyUri = Uri.file('/workspace/test.py');
    const tsUri = Uri.file('/workspace/test.ts');

    test('returns original array when no overrides defined', () => {
      const diags = [makeError()];
      const result = applySeverityOverrides(pyUri, diags, undefined);
      assert.strictEqual(result, diags);
    });

    test('returns original array when extension has no mapping', () => {
      const diags = [makeError()];
      const result = applySeverityOverrides(tsUri, diags, { '.py': { Error: 'Warning' } });
      assert.strictEqual(result, diags);
    });

    test('demotes error to warning for .py files', () => {
      const diags = [makeError()];
      const result = applySeverityOverrides(pyUri, diags, { '.py': { Error: 'Warning' } });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].severity, DiagnosticSeverity.Warning);
    });

    test('promotes warning to error for .js files', () => {
      const jsUri = Uri.file('/workspace/test.js');
      const diags = [makeWarning()];
      const result = applySeverityOverrides(jsUri, diags, { '.js': { Warning: 'Error' } });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].severity, DiagnosticSeverity.Error);
    });

    test('demotes multiple severities for same extension', () => {
      const diags = [makeError(), makeWarning(), makeInfo()];
      const result = applySeverityOverrides(pyUri, diags, {
        '.py': { Error: 'Warning', Warning: 'Information' },
      });
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].severity, DiagnosticSeverity.Warning);
      assert.strictEqual(result[1].severity, DiagnosticSeverity.Information);
      assert.strictEqual(result[2].severity, DiagnosticSeverity.Information);
    });

    test('returns original array when override maps to same severity', () => {
      const diags = [makeError()];
      const result = applySeverityOverrides(pyUri, diags, { '.py': { Error: 'Error' } });
      assert.strictEqual(result, diags);
    });

    test('ignores non-matching severity names', () => {
      const diags = [makeInfo()];
      const result = applySeverityOverrides(pyUri, diags, { '.py': { Error: 'Warning' } });
      assert.strictEqual(result, diags);
    });

    test('toProblemState with overrides produces correct counts', () => {
      const diags = [makeError(), makeError(), makeWarning()];
      const mapped = applySeverityOverrides(pyUri, diags, { '.py': { Error: 'Warning' } });
      const status = toProblemState(mapped);
      assert.strictEqual(status.errorCount, 0);
      assert.strictEqual(status.warningCount, 3);
      assert.strictEqual(status.severity, ProblemSeverity.Warning);
    });

    test('matches .d.ts extension for overrides', () => {
      const dtsUri = Uri.file('/workspace/types.d.ts');
      const diags = [makeError()];
      const mapped = applySeverityOverrides(dtsUri, diags, { '.d.ts': { Error: 'Warning' } });
      assert.strictEqual(mapped.length, 1);
      assert.strictEqual(mapped[0].severity, DiagnosticSeverity.Warning);
    });

    test('matches dashed extension like .spec.ts', () => {
      const specUri = Uri.file('/workspace/test.spec.ts');
      const diags = [makeError()];
      const mapped = applySeverityOverrides(specUri, diags, { '.spec.ts': { Error: 'Warning' } });
      assert.strictEqual(mapped.length, 1);
      assert.strictEqual(mapped[0].severity, DiagnosticSeverity.Warning);
    });

    test('matches simple extension correctly after fix', () => {
      const diags = [makeError()];
      const mapped = applySeverityOverrides(pyUri, diags, { '.py': { Error: 'Warning' } });
      assert.strictEqual(mapped.length, 1);
      assert.strictEqual(mapped[0].severity, DiagnosticSeverity.Warning);
    });
  });
});
