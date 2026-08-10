import { describe, expect, it } from 'vitest';

import { fileExtension, toEngineDiagnostic, toSourceSeverity } from '../src/severity.js';
import { ProblemSeverity } from '@pe/core';

describe('severity mapping', () => {
  it('maps vscode numeric severities', () => {
    expect(toSourceSeverity(0)).toBe('Error');
    expect(toSourceSeverity(1)).toBe('Warning');
    expect(toSourceSeverity(2)).toBe('Info');
    expect(toSourceSeverity(3)).toBe('Info');
  });

  it('maps diagnostic to 0-based engine diagnostic', () => {
    const mapped = toEngineDiagnostic(
      {
        severity: 1,
        message: 'unused var',
        source: 'ts',
        range: { start: { line: 3, character: 5 } },
      },
      undefined,
      'C:/repo/a.ts',
    );
    expect(mapped).toMatchObject({
      line: 3,
      column: 5,
      severity: ProblemSeverity.Warning,
      message: 'unused var',
      source: 'ts',
    });
  });

  it('clamps negative positions to 0', () => {
    const mapped = toEngineDiagnostic(
      { severity: 0, message: 'x', range: { start: { line: -2, character: -1 } } },
      undefined,
      'a.ts',
    );
    expect(mapped.line).toBe(0);
    expect(mapped.column).toBe(0);
  });

  it('applies per-extension severity overrides', () => {
    const mapped = toEngineDiagnostic(
      { severity: 0, message: 'py err', range: { start: { line: 0, character: 0 } } },
      { '.py': { Error: 'Warning' } },
      'C:\\repo\\x.py',
    );
    expect(mapped.severity).toBe(ProblemSeverity.Warning);
  });

  it('ignores overrides for other extensions', () => {
    const mapped = toEngineDiagnostic(
      { severity: 0, message: 'ts err', range: { start: { line: 0, character: 0 } } },
      { '.py': { Error: 'Warning' } },
      'C:\\repo\\x.ts',
    );
    expect(mapped.severity).toBe(ProblemSeverity.Error);
  });

  it('fileExtension handles windows and unix paths', () => {
    expect(fileExtension('C:\\repo\\x.py')).toBe('.py');
    expect(fileExtension('/repo/x.ts')).toBe('.ts');
    expect(fileExtension('/repo/noext')).toBe('');
  });
});