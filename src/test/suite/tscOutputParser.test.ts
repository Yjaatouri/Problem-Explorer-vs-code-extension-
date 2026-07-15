import * as assert from 'assert';
import { TscOutputParser, TscDiagnostic } from '../../typescript/TscOutputParser';
import { ProblemSeverity } from '../../core/types';

suite('TscOutputParser', () => {
  const parser = new TscOutputParser();

  test('parses a single error', () => {
    const output = 'src/file.ts(5,10): error TS2322: Type is not assignable.';
    const result = parser.parse(output);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file, 'src/file.ts');
    assert.strictEqual(result[0].line, 5);
    assert.strictEqual(result[0].column, 10);
    assert.strictEqual(result[0].severity, ProblemSeverity.Error);
    assert.strictEqual(result[0].code, 'TS2322');
    assert.strictEqual(result[0].message, 'Type is not assignable.');
  });

  test('parses a single warning', () => {
    const output = 'src/util.ts(42,8): warning TS6133: "x" is declared but never used.';
    const result = parser.parse(output);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file, 'src/util.ts');
    assert.strictEqual(result[0].line, 42);
    assert.strictEqual(result[0].column, 8);
    assert.strictEqual(result[0].severity, ProblemSeverity.Warning);
    assert.strictEqual(result[0].code, 'TS6133');
    assert.strictEqual(result[0].message, '"x" is declared but never used.');
  });

  test('parses multiple diagnostics', () => {
    const output = [
      'src/a.ts(1,1): error TS2322: Type error.',
      'src/b.ts(2,5): warning TS6133: Unused variable.',
      'src/c.ts(3,9): error TS2345: Argument type mismatch.',
    ].join('\n');

    const result = parser.parse(output);

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].code, 'TS2322');
    assert.strictEqual(result[1].code, 'TS6133');
    assert.strictEqual(result[2].code, 'TS2345');
  });

  test('ignores empty lines and summary lines', () => {
    const output = [
      '',
      'src/a.ts(1,1): error TS2322: Type error.',
      '',
      'Found 1 error.',
      '',
    ].join('\n');

    const result = parser.parse(output);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].code, 'TS2322');
  });

  test('ignores malformed lines', () => {
    const output = [
      'some random text',
      'src/a.ts(1,1) error TS2322: Missing colon after parentheses?',
      'error TS2322: Message without file location',
      'src/a.ts: error TS2322: Different format',
      'src/a.ts(abc,def): error TS2322: Non-numeric line/column',
      'src/a.ts(1,1): error: TS2322: Extra colon',
    ].join('\n');

    const result = parser.parse(output);

    assert.strictEqual(result.length, 0);
  });

  test('handles Windows paths with backslashes', () => {
    const output = 'C:\\Users\\me\\project\\src\\file.ts(10,3): error TS2554: Wrong arguments.';
    const result = parser.parse(output);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file, 'C:\\Users\\me\\project\\src\\file.ts');
    assert.strictEqual(result[0].line, 10);
    assert.strictEqual(result[0].column, 3);
  });

  test('handles files with spaces in path', () => {
    const output = 'src/my project/file.ts(1,1): error TS2322: Type error.';
    const result = parser.parse(output);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file, 'src/my project/file.ts');
  });

  test('handles multiline error messages', () => {
    const output = [
      'src/a.ts(1,1): error TS2322: First line.',
      '  Second line of message.',
      'src/b.ts(2,2): warning TS6133: Other diagnostic.',
    ].join('\n');

    const result = parser.parse(output);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].code, 'TS2322');
    assert.strictEqual(result[1].code, 'TS6133');
  });

  test('parses empty output', () => {
    const result = parser.parse('');
    assert.strictEqual(result.length, 0);
  });

  test('parses output with only whitespace', () => {
    const result = parser.parse('   \n  \n  ');
    assert.strictEqual(result.length, 0);
  });

  test('severity maps correctly', () => {
    const error = parser.parse('f.ts(1,1): error TS2322: msg.');
    const warning = parser.parse('f.ts(1,1): warning TS6133: msg.');

    assert.strictEqual(error[0].severity, ProblemSeverity.Error);
    assert.strictEqual(warning[0].severity, ProblemSeverity.Warning);
    assert.ok(error[0].severity > warning[0].severity);
  });

  test('code field contains TS prefix', () => {
    const result = parser.parse('f.ts(1,1): error TS2322: msg.');
    assert.strictEqual(result[0].code, 'TS2322');
  });

  test('message preserves quotes and special characters', () => {
    const result = parser.parse('f.ts(1,1): error TS2322: Type \'"hello"\' is not assignable.');
    assert.strictEqual(result[0].message, 'Type \'"hello"\' is not assignable.');
  });

  test('TscDiagnostic satisfies structural type', () => {
    const diag: TscDiagnostic = {
      file: 'f.ts',
      line: 1,
      column: 1,
      severity: ProblemSeverity.Error,
      code: 'TS2322',
      message: 'msg',
    };
    assert.strictEqual(diag.file, 'f.ts');
    assert.strictEqual(diag.code, 'TS2322');
  });

  test('import TscOutputParser is a class', () => {
    assert.strictEqual(typeof TscOutputParser, 'function');
  });
});
