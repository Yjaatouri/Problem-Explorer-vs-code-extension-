// End-to-end: the M6 architecture proof. A brand-new language family (Python,
// ruff) plugs into the finished engine with ONE line of registration
//
//   providers: [new RuffProvider()]
//
// and zero engine changes — this test is the only diff. The ruff binary comes
// from the environment (see resolveRuff below), exactly like tsc/eslint come
// from node_modules/.bin in the sibling e2e test. When ruff is missing the
// suite skips instead of failing — a CI/local gap, not an engine gap.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProblemSeverity, ProviderHealth, ScanType } from '@pe/core';
import type { Uri } from '@pe/core';
import { RuffProvider } from '@pe/provider-ruff';
import { DiagnosticsAPI } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'ruff-workspace');

function makeUri(fsPath: string): Uri {
  const normalized = fsPath.replace(/\\/g, '/');
  // Canonical form (matches Uri.file() / provider-reported keys):
  // `file://` + absolute path (the path already starts with '/'). On
  // Windows the drive path becomes `file:///C:/...` via the same rule.
  const withScheme = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return {
    scheme: 'file',
    authority: '',
    path: normalized,
    fsPath,
    toString: () => `file://${withScheme}`,
    with: (change: { path?: string }) => makeUri(change.path ?? fsPath),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await sleep(25);
  }
}

/** Locate the ruff executable: RUFF_BIN env var, else `ruff` on the PATH. */
function resolveRuff(): { bin: string; dir?: string } | undefined {
  const explicit = process.env.RUFF_BIN;
  if (explicit !== undefined && explicit.length > 0) {
    return { bin: explicit, dir: dirname(explicit) };
  }
  const probe = spawnSync('ruff', ['--version'], { windowsHide: true });
  if (probe.status === 0) {
    return { bin: 'ruff' };
  }
  return undefined;
}

const ruff = resolveRuff();
const runIt = ruff === undefined ? it.skip : it;

let workspace: string;
let api: DiagnosticsAPI;
let failPath: string;
let cleanPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pe-ruff-e2e-'));
  cpSync(FIXTURES, workspace, { recursive: true });
  failPath = join(workspace, 'fail.py');
  cleanPath = join(workspace, 'clean.py');
});

afterEach(async () => {
  api?.dispose();
  // Windows: a just-exited child may still hold a cwd handle on the workspace.
  await until(
    () => {
      try {
        rmSync(workspace, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
    'workspace cleanup',
    10_000,
  );
});

describe('end-to-end with the real ruff binary', () => {
  runIt('scans a python workspace with ruff registered in one line', async () => {
    const binDir = ruff?.dir;
    if (binDir !== undefined) {
      process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    }
    const originalCwd = process.cwd();
    process.chdir(workspace);
    try {
      const statuses = new Map<string, ProviderHealth>();
      api = new DiagnosticsAPI({
        workspaceRoot: makeUri(workspace),
        providers: [new RuffProvider()], // the one line
        config: { scanTimeoutMs: 120_000, debounceMs: 1, batchMs: 5 },
      });
      api.onProviderStatusChanged((event) => statuses.set(event.providerId, event.status.health));

      await api.scan(ScanType.Manual);
      await until(() => api.runningCount === 0 && api.queuedCount === 0, 'engine idle after scan');

      expect(api.getTotals()).toMatchObject({ errors: 1, warnings: 0 });

      const fail = api.getProblems(makeUri(failPath));
      expect(fail.severity).toBe(ProblemSeverity.Error);
      expect(fail.errorCount).toBe(1);
      expect(api.getOwners(makeUri(failPath))).toContain('ruff');

      expect(api.getProblems(makeUri(cleanPath)).errorCount).toBe(0);

      await until(() => statuses.get('ruff') === ProviderHealth.Ready, 'ruff ready');
    } finally {
      process.chdir(originalCwd);
    }
  });

  runIt('clears python diagnostics after a fix is saved (save scan)', async () => {
    const binDir = ruff?.dir;
    if (binDir !== undefined) {
      process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    }
    const originalCwd = process.cwd();
    process.chdir(workspace);
    try {
      api = new DiagnosticsAPI({
        workspaceRoot: makeUri(workspace),
        providers: [new RuffProvider()], // the one line
        config: { scanTimeoutMs: 120_000, debounceMs: 1, batchMs: 5 },
      });

      await api.scan(ScanType.Manual);
      await until(() => api.runningCount === 0 && api.queuedCount === 0, 'engine idle after scan');
      expect(api.getTotals().errors).toBe(1);

      writeFileSync(failPath, 'def greet() -> str:\n    return "hello"\n', 'utf8');
      api.scanOnSave(makeUri(failPath));
      await until(() => api.getTotals().errors === 0, 'errors cleared after fix');
      expect(api.getProblems(makeUri(failPath)).errorCount).toBe(0);
      expect(api.queuedCount).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
