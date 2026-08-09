import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScanType, type ScanContext, type Uri } from '@pe/provider-sdk';
import type { TscConfig } from '../src/index.js';
import { buildTscCommand, parseTscOutput } from '../src/index.js';

let projDir: string;
beforeAll(() => {
  projDir = mkdtempSync(join(tmpdir(), 'pe-tsc-'));
});
afterAll(() => {
  rmSync(projDir, { recursive: true, force: true });
});

function makeUri(fsPath: string): Uri {
  return {
    scheme: 'file',
    authority: '',
    path: fsPath.replace(/\\/g, '/'),
    fsPath,
    toString: () => `file:///${fsPath.replace(/\\/g, '/')}`,
    with: (change: { path?: string }) => makeUri(change.path ?? fsPath),
  };
}

function ctx(uris: readonly Uri[]): ScanContext {
  return { type: ScanType.Manual, trigger: 'manual', uris };
}

function config(overrides: Partial<TscConfig> = {}): TscConfig {
  return { enabled: true, extraArgs: [], ...overrides };
}

describe('parseTscOutput', () => {
  it('parses standard tsc diagnostics', () => {
    const issues = parseTscOutput(
      [
        "src/a.ts(3,5): error TS7002: Parameter 'x' implicitly has an 'any' type.",
        'k(1,2): warning TS6103: not used',
        'not a diagnostic line',
        'l(1,2): info TS6192: tidy',
      ].join('\n'),
    );
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({
      file: 'src/a.ts',
      line: 3,
      column: 5,
      severity: 'error',
      code: 'TS7002',
      message: "Parameter 'x' implicitly has an 'any' type.",
    });
    expect(issues[1]).toMatchObject({ severity: 'warning', code: 'TS6103' });
    expect(issues[2]).toMatchObject({ severity: 'info', code: 'TS6192' });
  });

  it('strips ANSI codes and crlf', () => {
    const issues = parseTscOutput('\x1b[31;1ma.ts(1,2): error TS1: red\r\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'a.ts', message: 'red' });
  });

  it('skips non-tsc lines', () => {
    expect(parseTscOutput('$ tsc\nfound 2 errors.\n')).toEqual([]);
  });

  it('parses severity-only lines (bare diagnostics)', () => {
    const issues = parseTscOutput('a.ts(4,5): error: broken pragma\n');
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.code).toBeUndefined();
  });
});

describe('buildTscCommand', () => {
  it('runs a full project scan for a directory uri', () => {
    const argv = buildTscCommand(ctx([makeUri(projDir)]), config());
    expect(argv).toEqual(['tsc', '--noEmit', '--pretty', 'false', '--project', projDir]);
  });

  it('runs a per-file scan for file uris', () => {
    const argv = buildTscCommand(ctx([makeUri('/a/x.ts')]), config());
    expect(argv).toEqual(['tsc', '--noEmit', '--pretty', 'false', '--ignoreConfig', '/a/x.ts']);
  });

  it('appends extra args', () => {
    const argv =
      buildTscCommand(ctx([makeUri('/a.ts')]), config({ extraArgs: ['--strict', '-w'] })) ?? [];
    expect(argv).toContain('--strict');
    expect(argv[argv.length - 1]).toBe('/a.ts');
  });

  it('returns null when no uris (engine will skip)', () => {
    expect(buildTscCommand(ctx([]), config())).toBeNull();
  });
});
