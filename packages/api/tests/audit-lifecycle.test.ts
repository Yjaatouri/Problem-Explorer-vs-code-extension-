// TASK 9 — Lifecycle & resource-safety audit at the DiagnosticsAPI level.
// Real pipeline (index → analyzer → scheduler → store) with in-process fake
// providers: save storms end-to-end, cache effectiveness, create→dispose
// cycles (100 and 500), watcher/disposal silence, and 50 rebuild cycles
// proving only one live engine exists and nothing multiplies.

import { DiagnosticsAPI } from '../src/diagnostics-api.js';
import { ProblemSeverity, ProviderHealth, ScanType } from '@pe/core';
import type { Diagnostic, Provider, ScanContext } from '@pe/core';
import { fileUriFromPath } from '@pe/workspace-index';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor: condition never became true'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function record(key: string, value: unknown): void {
  console.log(`[AUDIT] ${key}=${value}`);
}

interface FakeProvider {
  readonly provider: Provider;
  readonly calls: ScanContext[];
}

function makeFakeProvider(
  id: string,
  overrides: { capabilities?: Partial<Provider['capabilities']> } = {},
): FakeProvider {
  const calls: ScanContext[] = [];
  const provider = {
    id,
    displayName: id,
    capabilities: {
      confidenceTier: 3,
      supportedConfigTypes: ['typescript'],
      workspaceScan: true,
      incrementalScan: true,
      realtime: false,
      extensions: ['.ts', '.tsx'],
      cost: 'cheap',
      ...(overrides.capabilities as Partial<Provider['capabilities']>),
    },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    healthCheck: async () => ({ health: ProviderHealth.Ready }),
    scan: async (context) => {
      calls.push(context);
      const files =
        context.uris?.map((uri) => ({
          uri,
          diagnostics: [
            { line: 0, column: 0, severity: ProblemSeverity.Warning, message: 'audit', source: id },
          ],
        })) ?? [];
      return { changedUris: context.uris ?? [], files };
    },
  } as Provider;
  return { provider, calls };
}

let dir: string;
let apis: DiagnosticsAPI[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pe-audit-'));
  writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;', 'utf8');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 2;', 'utf8');
});

afterEach(() => {
  for (const api of apis) {
    api.dispose();
  }
  apis = [];
  rmSync(dir, { recursive: true, force: true });
});

function createApi(
  provider: Provider,
  config: Record<string, unknown> = { debounceMs: 10, batchMs: 20 },
): DiagnosticsAPI {
  const api = new DiagnosticsAPI({
    workspaceRoot: fileUriFromPath(dir),
    providers: [provider],
    config,
  });
  apis.push(api);
  return api;
}

describe('Task9 audit — API lifecycle & resource safety', () => {
  it('save storm through the real pipeline: 1000 saves-on-save → 1 extra scan', async () => {
    const fake = makeFakeProvider('storm');
    const api = createApi(fake.provider);
    const uri = fileUriFromPath(join(dir, 'a.ts'));
    await api.scan(ScanType.Manual);
    await waitFor(() => api.getTotals().warnings === 1);
    const baseline = fake.calls.length;

    let peak = 0;
    const stateDisposable = api.onScanStateChanged((state) => {
      peak = Math.max(peak, state.running + state.queued);
    });

    const SAVES = 1000;
    const started = Date.now();
    for (let i = 0; i < SAVES; i += 1) {
      writeFileSync(join(dir, 'a.ts'), `export const a = ${i};\n`, 'utf8');
      api.scanOnSave(uri);
    }
    await waitFor(() => fake.calls.length === baseline + 1, 10000);
    await new Promise((resolve) => setTimeout(resolve, 100)); // no extra jobs behind the batch
    stateDisposable.dispose();

    const jobsExecuted = fake.calls.length - baseline;
    expect(jobsExecuted).toBe(1);
    expect(peak).toBeLessThanOrEqual(1);
    record(
      'api-storm-1000',
      `events=${SAVES} scans=${jobsExecuted} jobsExecuted=${jobsExecuted} peak=${peak} timeMs=${Date.now() - started}`,
    );
  });

  it('cache effectiveness: unchanged saves rescan nothing, one changed file rescans only it', async () => {
    const fake = makeFakeProvider('cached');
    const api = createApi(fake.provider);
    const aUri = fileUriFromPath(join(dir, 'a.ts'));
    const bUri = fileUriFromPath(join(dir, 'b.ts'));

    await api.scan(ScanType.Manual);
    await waitFor(() => api.getTotals().warnings === 1); // one workspace-root scan
    const afterManual = fake.calls.length;

    // Save nothing changed: identical mtime+size → no-op diff, zero scans.
    api.scanOnSave(aUri);
    api.scanOnSave(bUri);
    await new Promise((resolve) => setTimeout(resolve, 120)); // past debounce+batch
    expect(fake.calls.length).toBe(afterManual);

    // One changed file → exactly one scan limited to that file.
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2; // changed\n', 'utf8');
    api.scanOnSave(bUri);
    await waitFor(() => fake.calls.length === afterManual + 1);
    expect(fake.calls.at(-1)?.uris?.map((u) => u.path)).toEqual([bUri.path]);

    // A README (no capability) save never wakes the scheduler.
    writeFileSync(join(dir, 'README.md'), '# hi\n', 'utf8');
    api.scanOnSave(fileUriFromPath(join(dir, 'README.md')));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.calls.length).toBe(afterManual + 1);
    record('cache', 'unchangedSavesRescans=0 changedFileOnly=true readmeWakesScheduler=false');
  });

  it('watcher audit: no scans or events after disposal, control path works before', async () => {
    const fake = makeFakeProvider('watch');
    const api = createApi(fake.provider);
    const uri = fileUriFromPath(join(dir, 'a.ts'));

    // Control: the write-scan path works while the engine is live.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 42;\n', 'utf8');
    api.scanOnSave(uri);
    await waitFor(() => fake.calls.length >= 1);

    let postDisposeEvents = 0;
    const eventDisposable = api.onProblemsChanged(() => {
      postDisposeEvents += 1;
    });

    api.dispose();
    apis = apis.filter((other) => other !== api);

    writeFileSync(join(dir, 'a.ts'), 'export const a = 43;\n', 'utf8');
    api.scanOnSave(uri);
    await api.scan(ScanType.Manual);
    await new Promise((resolve) => setTimeout(resolve, 150));
    eventDisposable.dispose();

    expect(api.queuedCount).toBe(0);
    expect(api.runningCount).toBe(0);
    expect(api.getTotals()).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(postDisposeEvents).toBe(0);
    expect(fake.calls.length).toBe(1); // control only
    record('watcher-disposal', 'postDisposeScans=0 postDisposeEvents=0 storeEmpty=true');
  });

  it('lifecycle: 100 create→start→scan→dispose cycles release every resource', async () => {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const fake = makeFakeProvider(`cycle-${cycle}`);
      const api = createApi(fake.provider);
      let problemsAfter = 0;
      let totalsAfter = 0;
      let stateAfter = 0;
      const problemsDisposable = api.onProblemsChanged(() => {
        problemsAfter += 1;
      });
      const totalsDisposable = api.onTotalsChanged(() => {
        totalsAfter += 1;
      });
      const stateDisposable = api.onScanStateChanged(() => {
        stateAfter += 1;
      });

      await api.scan(ScanType.Manual);
      await waitFor(() => api.getTotals().warnings >= 1);
      expect(api.queuedCount).toBe(0);
      expect(api.runningCount).toBe(0);

      api.dispose();
      apis = apis.filter((other) => other !== api);
      const stateAtDispose = stateAfter;
      const problemsAtDispose = problemsAfter;
      const totalsAtDispose = totalsAfter;

      expect(api.getTotals()).toEqual({ errors: 0, warnings: 0, info: 0 });
      expect(api.queuedCount).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // No ghost events after dispose: counters frozen at their dispose-time values.
      expect(problemsAfter).toBe(problemsAtDispose);
      expect(totalsAfter).toBe(totalsAtDispose);
      // dispose() itself emits one final idle state; nothing after that.
      expect(stateAfter).toBe(stateAtDispose);
      problemsDisposable.dispose();
      totalsDisposable.dispose();
      stateDisposable.dispose();
    }
    record(
      'lifecycle-100',
      'cycles=100 disposedInert=true totalsZeroed=true noEventsAfterDispose=true',
    );
  });

  it('lifecycle: 500 create→start→scan→dispose cycles stay stable (no growth)', async () => {
    let maxRunningSeen = 0;
    for (let cycle = 0; cycle < 500; cycle += 1) {
      const fake = makeFakeProvider(`c500-${cycle}`);
      const api = createApi(fake.provider);
      let problemsAfter = 0;
      const disposable = api.onProblemsChanged(() => {
        problemsAfter += 1;
      });

      await api.scan(ScanType.Manual);
      await waitFor(() => api.getTotals().warnings >= 1);
      maxRunningSeen = Math.max(maxRunningSeen, api.runningCount);

      api.dispose();
      apis = apis.filter((other) => other !== api);
      expect(api.getTotals().warnings).toBe(0);
      const problemsAtDispose = problemsAfter;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(problemsAfter).toBe(problemsAtDispose); // no ghost events after dispose
      disposable.dispose();
    }
    expect(maxRunningSeen).toBeLessThanOrEqual(1);
    record('lifecycle-500', `cycles=500 peakRunning=${maxRunningSeen} stable=true`);
  });

  it('rebuild stress: 50 consecutive rebuilds — only one live engine, no duplicated events', async () => {
    const uri = fileUriFromPath(join(dir, 'a.ts'));
    const engines: Array<{ api: DiagnosticsAPI; events: number }> = [];

    for (let cycle = 0; cycle < 50; cycle += 1) {
      const fake = makeFakeProvider('vscode', { capabilities: { realtime: true } });
      const api = createApi(fake.provider);
      const entry = { api, events: 0 };
      engines.push(entry);
      const disposable = api.onProblemsChanged(() => {
        entry.events += 1;
      });

      // Old engines sit at their own counts — nothing multiplied into them.
      for (const old of engines.slice(0, -1)) {
        expect(old.events).toBe(1);
        expect(old.api.getTotals()).toEqual({ errors: 0, warnings: 0, info: 0 });
      }

      const diagnostic: Diagnostic = {
        line: 0,
        column: 0,
        severity: ProblemSeverity.Error,
        message: `cycle ${cycle}`,
        source: 'vscode',
      };
      api.reportEditorDiagnostics(uri, [diagnostic]);
      expect(api.getTotals().errors).toBe(1); // lands on the live engine only
      expect(api.getOwners(uri)).toEqual(['vscode']);
      expect(entry.events).toBe(1);

      api.dispose();
      apis = apis.filter((other) => other !== api);
      disposable.dispose();
      expect(api.getTotals().errors).toBe(0);
    }
    for (const engine of engines) {
      expect(engine.events).toBe(1); // exactly one push per engine, never duplicated
    }
    record('rebuild-50', 'cycles=50 singleLiveEngine=true eventsPerEngine=1 noDuplication=true');
  });
});
