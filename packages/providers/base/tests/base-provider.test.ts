// BaseProvider behavioral tests — real child processes, real exit codes.
// The fixture executable is a Node script that mimics a tool's stdout and
// exit behavior: issues, failure-with-output, failure-without-output, and a
// hanging process (for timeouts). No external tool is installed in the test
// environment.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ProviderHealth,
  ScanType,
  type ScanContext,
  type ScanResult,
  type Uri,
} from '@pe/provider-sdk';
import { BaseProvider } from '../src/index.js';
import type { BaseProviderOptions, ParsedIssue } from '../src/index.js';

const FIXTURE = String.raw`
const mode = process.argv[2];
if (mode === 'issues') {
  console.log("src/a.ts(1,5): error TS7002: Parameter 'x' implicitly has an 'any' type.");
  console.log("src/b.ts(10,20): warning TS6103: 'dead code'");
  process.exit(1);
}
if (mode === 'empty-fail') {
  process.exit(2);
}
if (mode === 'sleep') {
  setTimeout(function () {}, 5000);
} else {
  process.exit(0);
}
`;

function parseFixture(stdout: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.*)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
    if (m !== null) {
      issues.push({
        file: m[1] ?? '',
        line: Number(m[2]),
        column: Number(m[3]),
        severity: m[4] as 'error' | 'warning',
        code: m[5] ?? '',
        message: (m[6] ?? '').trim(),
      });
    }
  }
  return issues;
}

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

let dir: string;
let fixture: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pe-base-test-'));
  fixture = join(dir, 'fixture.cjs');
  writeFileSync(fixture, FIXTURE, 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeProvider(opts: Partial<BaseProviderOptions> = {}): BaseProvider {
  return new BaseProvider({
    id: 'fixture',
    displayName: 'Fixture Provider',
    capabilities: {
      confidenceTier: 3,
      supportedConfigTypes: ['typescript'],
      workspaceScan: true,
      incrementalScan: false,
      realtime: false,
      extensions: ['.ts'],
      cost: 'cheap',
    },
    buildCommand: () => [process.execPath, fixture, 'issues'],
    parseOutput: parseFixture,
    ...opts,
  });
}

const context: ScanContext = { type: ScanType.Save, trigger: 'save', uris: [makeUri('/src/a.ts')] };

function firstFile(result: ScanResult) {
  const file = result.files?.[0];
  if (file === undefined) {
    throw new Error('expected files in result');
  }
  return file;
}

describe('BaseProvider', () => {
  describe('scan()', () => {
    it('maps tool output into per-file diagnostics (0-based line/column)', async () => {
      const result = await makeProvider().scan(context);
      expect(result.errors).toBeUndefined();
      const files = result.files ?? [];
      expect(files).toHaveLength(2);

      const a = firstFile(result);
      expect(a.uri.path.endsWith('src/a.ts')).toBe(true);
      expect(a.diagnostics[0]).toMatchObject({
        line: 0,
        column: 4,
        severity: 3,
        message: "Parameter 'x' implicitly has an 'any' type.",
        source: 'fixture',
        code: 'TS7002',
      });

      const b = files[1]?.diagnostics[0];
      expect(b).toMatchObject({ severity: 2, code: 'TS6103' });
    });

    it('reports a tool failure as a scan error when output is empty', async () => {
      const result = await makeProvider({
        buildCommand: () => [process.execPath, fixture, 'empty-fail'],
      }).scan(context);
      expect(result.files ?? []).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });

    it('returns a missing-binary error when the executable does not exist', async () => {
      const result = await makeProvider({
        buildCommand: () => ['definitely-not-a-binary-pe-xyz'],
      }).scan(context);
      expect(result.files ?? []).toHaveLength(0);
      expect(result.errors?.[0]?.code).toBe('ENOENT');
      expect(result.errors?.[0]?.message).toContain('not found');
    });

    it('does not run anything when enabled is false', async () => {
      const result = await makeProvider({ defaultConfig: { enabled: false } }).scan(context);
      expect(result.files).toHaveLength(0);
      expect(result.errors).toBeUndefined();
    });

    it('returns changedUris as given', async () => {
      const result = await makeProvider().scan(context);
      expect(result.changedUris).toHaveLength(1);
      expect(result.changedUris[0]?.path).toBe('/src/a.ts');
    });

    it('builds an absolute path for relative reports against the scan cwd', async () => {
      const result = await makeProvider({ cwdFor: () => dir }).scan(context);
      const a = firstFile(result);
      expect(a.uri.path).toBe(`${dir.replace(/\\/g, '/')}/src/a.ts`);
    });

    it('kills the child on timeout and reports a scan error', async () => {
      const result = await makeProvider({
        buildCommand: () => [process.execPath, fixture, 'sleep'],
        timeoutMs: 150,
      }).scan(context);
      expect(result.files ?? []).toHaveLength(0);
      expect((result.errors ?? []).map((e) => e.message).join('|')).toContain('timed out');
    });
  });

  describe('healthCheck()', () => {
    it('trivially Ready when no healthCommand is configured', async () => {
      expect(await makeProvider().healthCheck()).toEqual({ health: ProviderHealth.Ready });
    });

    it('reports MissingDependency when the health command is absent from PATH', async () => {
      const status = await makeProvider({
        healthCommand: ['definitely-not-a-binary-pe-xyz', '--version'],
      }).healthCheck();
      expect(status.health).toBe(ProviderHealth.MissingDependency);
    });
  });
});
