// DiagnosticsAPI — end-to-end wiring tests. Real pipeline: index → analyzer →
// scheduler → store, with a fake provider. No mocks inside the engine.

import { DiagnosticsAPI } from '../src/diagnostics-api.js';
import { ProblemSeverity, ProviderHealth, ScanType } from '@pe/core';
import type { DiagnosticsChangedEvent, Provider, ScanStateEvent } from '@pe/core';
import { fileUriFromPath } from '@pe/workspace-index';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
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

let version = 0;

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'tsc-test',
    displayName: 'TSC Test',
    capabilities: {
      confidenceTier: 3,
      supportedConfigTypes: ['typescript'],
      workspaceScan: true,
      incrementalScan: true,
      realtime: true,
      extensions: ['.ts', '.tsx'],
      cost: 'cheap',
    },
    configSchema: { type: 'object' },
    defaultConfig: {},
    healthCheck: async () => ({ health: ProviderHealth.Ready }),
    scan: async (context) => {
      const targets: ReturnType<typeof fileUriFromPath>[] = [];
      for (const uri of context.uris ?? []) {
        if (/\.tsx?$/.test(uri.path)) {
          targets.push(uri);
        } else if (statSync(uri.fsPath).isDirectory()) {
          // workspace plans carry the project root (§5.8): a workspace
          // scanner expands it; this test double mimics that behavior
          for (const rel of readdirSync(uri.fsPath, { recursive: true, encoding: 'utf8' })) {
            const full = join(uri.fsPath, rel);
            if (/\.tsx?$/.test(full)) {
              targets.push(fileUriFromPath(full));
            }
          }
        }
      }
      return {
        changedUris: targets,
        files: targets.map((uri) => ({
          uri,
          diagnostics: Array.from({ length: version + 1 }, () => ({
            line: 0,
            column: 0,
            severity: ProblemSeverity.Error,
            message: `err ${uri.path} v${version}`,
            source: 'tsc-test',
          })),
        })),
      };
    },
    ...overrides,
  };
}

let dir: string;
let api: DiagnosticsAPI | undefined;

beforeEach(() => {
  version = 0;
  dir = mkdtempSync(join(tmpdir(), 'pe-api-'));
  writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;', 'utf8');
  writeFileSync(join(dir, 'b.tsx'), 'export const b = 2;', 'utf8');
});

afterEach(() => {
  api?.dispose();
  api = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function createApi(provider = makeProvider()): DiagnosticsAPI {
  api = new DiagnosticsAPI({
    workspaceRoot: fileUriFromPath(dir),
    providers: [provider],
    config: { debounceMs: 10, batchMs: 20 },
  });
  return api;
}

const aUri = (): ReturnType<typeof fileUriFromPath> => fileUriFromPath(join(dir, 'a.ts'));

describe('DiagnosticsAPI', () => {
  it('manual scan flows end-to-end into the store', async () => {
    const api = createApi();
    await api.scan(ScanType.Manual);
    await waitFor(() => api.getTotals().errors === 2);
    const summary = api.getProblems(aUri());
    expect(summary.errorCount).toBe(1);
    expect(summary.fileCount).toBe(1);
    expect(api.getOwners(aUri())).toEqual(['tsc-test']);
    expect(api.rejectedWriteCount).toBe(0);
  });

  it('emits onProblemsChanged when diagnostics land', async () => {
    const api = createApi();
    const events: DiagnosticsChangedEvent[] = [];
    api.onProblemsChanged((event) => events.push(event));
    await api.scan(ScanType.Manual);
    await waitFor(() => events.length >= 1);
    expect(events[0]!.providerId).toBe('tsc-test');
    expect(events[0]!.diagnostics.length).toBeGreaterThan(0);
  });

  it('emits onScanStateChanged scanning → idle', async () => {
    const api = createApi();
    const phases: string[] = [];
    api.onScanStateChanged((event: ScanStateEvent) => phases.push(event.phase));
    await api.scan(ScanType.Manual);
    await waitFor(() => api.getTotals().errors === 2);
    await waitFor(() => phases.includes('idle'));
    expect(phases).toContain('scanning');
    expect(api.runningCount).toBe(0);
    expect(api.queuedCount).toBe(0);
  });

  it('scanOnSave picks up a changed file (mtime diff)', async () => {
    const api = createApi();
    await api.scan(ScanType.Manual);
    await waitFor(() => api.getTotals().errors === 2);
    version = 1;
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;', 'utf8');
    utimesSync(join(dir, 'a.ts'), new Date(), new Date());
    api.scanOnSave(aUri());
    await waitFor(() => api.getTotals().errors === 3); // a.ts rescanned with 2 errors
  });

  it('scanOnSave on a removed file invalidates without crashing', async () => {
    const api = createApi();
    rmSync(join(dir, 'b.tsx'));
    api.scanOnSave(fileUriFromPath(join(dir, 'b.tsx')));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(api.getTotals().errors).toBe(0);
  });

  it('rescanAll forces fresh results even when cached', async () => {
    const api = createApi();
    await api.scan(ScanType.Manual);
    await waitFor(() => api.getTotals().errors === 2);
    version = 2;
    await api.rescanAll();
    await waitFor(() => api.getTotals().errors === 6); // 3 errors × 2 files
  });

  it('a failed health check surfaces via onProviderStatusChanged and blocks scans', async () => {
    const broken = makeProvider({
      id: 'broken',
      healthCheck: async () => ({ health: ProviderHealth.Failed, message: 'no tsc on PATH' }),
    });
    const api = createApi(broken);
    const statuses: string[] = [];
    api.onProviderStatusChanged((event) => statuses.push(event.status.health));
    await waitFor(() => statuses.includes('failed'));
    await api.scan(ScanType.Manual);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.getTotals().errors).toBe(0);
    expect(statuses.at(-1)).toBe('failed');
  });

  it('dispose unsubscribes everything and stops the pipeline', async () => {
    const api = createApi();
    const problems: DiagnosticsChangedEvent[] = [];
    api.onProblemsChanged((event) => problems.push(event));
    api.dispose();
    await api.scan(ScanType.Manual);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(problems).toHaveLength(0);
    expect(api.getTotals().errors).toBe(0);
    expect(api.getProblems(aUri()).errorCount).toBe(0);
  });
});
