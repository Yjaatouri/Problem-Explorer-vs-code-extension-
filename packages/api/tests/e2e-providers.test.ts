// End-to-end: the whole engine driven by two REAL providers.
//
// This is the closest thing to production in this repo: a fixture workspace
// with a real tsconfig + a real ESLint flat config is copied to a temp dir;
// the tsc and eslint binaries come from the monorepo's own devDependencies
// (node_modules/.bin), and the full pipeline
//   index → impact analyzer → scheduler → provider child-process → store
// is exercised in-process. It asserts on DiagnosticsAPI state only — the
// consumer never touches engines directly.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderHealth, ProblemSeverity, ScanType } from '@pe/core';
import type { Uri } from '@pe/core';
import { DiagnosticsAPI } from '../src/index.js';
import { EslintProvider } from '@pe/provider-eslint';
import { TscProvider } from '@pe/provider-tsc';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'tsc-workspace');
const BIN = join(here, '..', '..', '..', 'node_modules', '.bin');

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

let workspace: string;
let api: DiagnosticsAPI;
let tscPath: string;
let eslintPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pe-e2e-'));
  cpSync(FIXTURES, workspace, { recursive: true });
  tscPath = join(workspace, 'a.ts');
  eslintPath = join(workspace, 'b.js');
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

describe('end-to-end with real tsc + eslint', () => {
  it('scans a workspace with real tools and surfaces problems through the API', async () => {
    process.env.PATH = `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const originalCwd = process.cwd();
    process.chdir(workspace);
    try {
      const statuses = new Map<string, ProviderHealth>();
      api = new DiagnosticsAPI({
        workspaceRoot: makeUri(workspace),
        providers: [new TscProvider(), new EslintProvider()],
        config: { scanTimeoutMs: 120_000, debounceMs: 1, batchMs: 5 },
      });
      api.onProviderStatusChanged((event) => statuses.set(event.providerId, event.status.health));

      await api.scan(ScanType.Manual);
      await until(() => api.runningCount === 0 && api.queuedCount === 0, 'engine idle after scan');

      // Totals: 1 TS error + 1 ESLint warning (console.log)
      const totals = api.getTotals();
      expect(totals.errors).toBe(1);
      expect(totals.warnings).toBe(1);

      // a.ts carries the TS2322 error from provider 'tsc'
      const aProblems = api.getProblems(makeUri(tscPath));
      expect(aProblems.severity).toBe(ProblemSeverity.Error);
      expect(aProblems.errorCount).toBe(1);
      expect(api.getOwners(makeUri(tscPath))).toContain('tsc');

      // b.js carries the console warning from provider 'eslint'
      expect(api.getProblems(makeUri(eslintPath)).warningCount).toBe(1);

      // Both tools health-checked Ready
      await until(() => statuses.get('tsc') === ProviderHealth.Ready, 'tsc ready');
      await until(() => statuses.get('eslint') === ProviderHealth.Ready, 'eslint ready');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('clears diagnostics after a fix is saved (incremental save scan)', async () => {
    process.env.PATH = `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
    const originalCwd = process.cwd();
    process.chdir(workspace);
    try {
      api = new DiagnosticsAPI({
        workspaceRoot: makeUri(workspace),
        providers: [new TscProvider()],
        config: { scanTimeoutMs: 120_000, debounceMs: 1, batchMs: 5 },
      });

      await api.scan(ScanType.Manual);
      await until(() => api.runningCount === 0 && api.queuedCount === 0, 'engine idle after scan');
      expect(api.getTotals().errors).toBe(1);

      // Fix the type error and re-scan just that file
      writeFileSync(tscPath, 'export const answer: number = 42;\n', 'utf8');
      api.scanOnSave(makeUri(tscPath));
      await until(() => api.getTotals().errors === 0, 'errors cleared after fix');
      expect(api.getProblems(makeUri(tscPath)).errorCount).toBe(0);
      expect(api.queuedCount).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
