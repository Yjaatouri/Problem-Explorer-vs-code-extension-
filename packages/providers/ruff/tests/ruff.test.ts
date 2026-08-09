import { describe, expect, it } from 'vitest';

import { parseRuffJson } from '../src/index.js';

describe('parseRuffJson', () => {
  it('parses the classic ruff JSON shape (filename / location)', () => {
    const stdout = JSON.stringify([
      {
        filename: 'main.py',
        location: { row: 4, column: 2 },
        message: 'Undefined name `x`',
        code: 'F821',
      },
    ]);
    const issues = parseRuffJson(stdout);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'main.py', line: 4, column: 2, code: 'F821' });
  });

  it('parses the new ruff shape (file / line / column)', () => {
    const stdout = JSON.stringify([
      {
        file: 'lib/a.py',
        line: 12,
        column: 1,
        message: 'Formatting',
        code: 'E501',
        severity: 'warning',
      },
    ]);
    const issues = parseRuffJson(stdout);
    expect(issues[0]).toMatchObject({ file: 'lib/a.py', line: 12, severity: 'warning' });
  });

  it('infers severity from the code when severity is absent', () => {
    const issues = parseRuffJson(
      JSON.stringify([
        { filename: 'a.py', location: { row: 1, column: 1 }, message: 'm', code: 'F401' },
        { filename: 'a.py', location: { row: 2, column: 1 }, message: 'm', code: 'W291' },
      ]),
    );
    expect(issues.map((i) => i.severity)).toEqual(['error', 'warning']);
  });

  it('ignores items without a file', () => {
    const issues = parseRuffJson(JSON.stringify([{ message: 'x', code: 'E' }]));
    expect(issues).toHaveLength(0);
  });

  it('returns [] on unparseable output', () => {
    expect(parseRuffJson('garbage')).toEqual([]);
  });
});
