import { describe, expect, it } from 'vitest';

import { parseEslintJson } from '../src/index.js';

describe('parseEslintJson', () => {
  it('maps messages to issues with severity and rule code', () => {
    const stdout = JSON.stringify([
      {
        filePath: '/repo/src/a.js',
        messages: [
          {
            line: 3,
            column: 5,
            severity: 2,
            ruleId: 'no-unused-vars',
            message: "'x' is assigned a value but never used.",
          },
          { line: 10, column: 1, severity: 1, ruleId: 'semi', message: 'Missing semicolon.' },
          {
            line: 20,
            column: 1,
            severity: 2,
            ruleId: null,
            message: 'Parsing error: Unexpected token g',
          },
        ],
      },
    ]);
    const issues = parseEslintJson(stdout);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({
      file: '/repo/src/a.js',
      line: 3,
      column: 5,
      severity: 'error',
      code: 'no-unused-vars',
    });
    expect(issues[1]).toMatchObject({ severity: 'warning', code: 'semi' });
    expect(issues[2]?.severity).toBe('error');
    expect(issues[2]?.code).toBeUndefined();
  });

  it('returns [] on unparseable output', () => {
    expect(parseEslintJson('not json')).toEqual([]);
  });

  it('returns [] on empty output', () => {
    expect(parseEslintJson('[]')).toEqual([]);
  });
});
