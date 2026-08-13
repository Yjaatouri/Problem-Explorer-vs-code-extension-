// TASK 10 — M7 startup & scan-latency baselines at the DiagnosticsAPI level.
// Real pipeline (index → analyzer → scheduler → store) with an in-process
// fake provider over synthetic workspaces of 1k / 10k / 50k files. Mirrors the
// extension boot (engine.ts): construct (sync index walk) → provider Ready →
// ScanType.Startup. The fake's scan is instant, so the numbers isolate engine
// overhead — the external tool (tsc/eslint/ruff) is measured nowhere here.
// Audit-first: baselines are recorded, never judged against invented targets.
//
// Measured finding (see docs/architecture/perf-reliability-audit.md §Task 10):
// every requestScan triggers 2-4x its intended work — the file plan for the
// whole workspace plus post-scan full re-scans driven by the Scanning→Ready
// status event → onProviderHealthChanged → stale-owned rescan. Recorded as
// call/uri totals per phase; latency is measured to full quiet (a 300ms grace
// window with no new work), so both numbers reflect the real engine.

import { DiagnosticsAPI } from '../src/diagnostics-api.js';
import { ProblemSeverity, ProviderHealth, ScanType } from '@pe/core';
import type { Provider, ScanContext, Uri } from '@pe/core';
import { fileUriFromPath } from '@pe/workspace-index';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function record(key: string, value: unknown): void {
  console.log(`[AUDIT] ${key}=${value}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once `calls.length >= minCalls`, running is 0, and no new scan has
 * started for a 300ms grace window (the post-scan status cascade has ended). */
async function waitQuiet(
  api: DiagnosticsAPI,
  calls: unknown[],
  minCalls: number,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (calls.length >= minCalls && api.runningCount === 0) {
      await sleep(300);
      if (calls.length >= minCalls && api.runningCount === 0) {
        return;
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitQuiet: never reached quiet idle');
    }
    await sleep(20);
  }
}

interface FakeProvider {
  readonly provider: Provider;
  readonly calls: ScanContext[];
}

function makeFakeProvider(id: string): FakeProvider {
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
    },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    healthCheck: async () => ({ health: ProviderHealth.Ready }),
    scan: async (context: ScanContext) => {
      calls.push(context);
      const files = (context.uris ?? []).map((uri) => ({
        uri,
        diagnostics: [
          { line: 0, column: 0, severity: ProblemSeverity.Warning, message: 'bench', source: id },
        ],
      }));
      return { changedUris: context.uris ?? [], files };
    },
  } as Provider;
  return { provider, calls };
}

/** Create `fileCount` .ts files under 25 buckets; returns every file uri. */
function makeWorkspace(dir: string, fileCount: number): Uri[] {
  const uris: Uri[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    const bucketDir = join(dir, `mod${i % 25}`);
    mkdirSync(bucketDir, { recursive: true });
    const file = join(bucketDir, `f${i}.ts`);
    writeFileSync(file, `export const v${i} = ${i};\n`, 'utf8');
    uris.push(fileUriFromPath(file));
  }
  return uris;
}

describe('Task10 audit — M7 startup & scan latency', () => {
  for (const fileCount of [1000, 10_000, 50_000]) {
    it(`${fileCount} files: startup latency, workspace + incremental scan latency, heap delta`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pe-bench-'));
      try {
        writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
        const uris = makeWorkspace(dir, fileCount);
        const heapBefore = process.memoryUsage().heapUsed;

        const fake = makeFakeProvider(`bench-${fileCount}`);
        const constructStart = Date.now();
        const api = new DiagnosticsAPI({
          workspaceRoot: fileUriFromPath(dir),
          providers: [fake.provider],
          config: { debounceMs: 10, batchMs: 20 },
        });
        const constructMs = Date.now() - constructStart;

        // Extension boot: startup scan after construction.
        void api.scan(ScanType.Startup);
        await waitQuiet(api, fake.calls, 1);
        const startupMs = Date.now() - constructStart;
        const startupCalls = fake.calls.length;
        const startupUris = fake.calls.reduce((sum, c) => sum + (c.uris?.length ?? 0), 0);

        // Workspace manual scan (whole workspace).
        const scanStart = Date.now();
        await api.scan(ScanType.Manual);
        await waitQuiet(api, fake.calls, startupCalls + 1);
        const scanMs = Date.now() - scanStart;
        const manualCalls = fake.calls.length - startupCalls;
        const manualUris = fake.calls
          .slice(startupCalls)
          .reduce((sum, c) => sum + (c.uris?.length ?? 0), 0);

        // Incremental scan of 100 specific files.
        const incrementalStart = Date.now();
        await api.scan(ScanType.Manual, uris.slice(0, 100));
        await waitQuiet(api, fake.calls, fake.calls.length + 1);
        const incrementalMs = Date.now() - incrementalStart;
        const incrementalCalls = fake.calls.length - startupCalls - manualCalls;
        const incrementalUris = fake.calls
          .slice(startupCalls + manualCalls)
          .reduce((sum, c) => sum + (c.uris?.length ?? 0), 0);

        const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
        const totals = api.getTotals();

        expect(api.runningCount).toBe(0);
        expect(api.queuedCount).toBe(0);
        expect(totals.warnings).toBeGreaterThanOrEqual(1);
        expect(startupCalls).toBeGreaterThanOrEqual(1);
        expect(manualCalls).toBeGreaterThanOrEqual(1);

        record(
          `startup-${fileCount}`,
          `files=${fileCount} constructMs=${constructMs} startupMs=${startupMs} scanMs=${scanMs} incrementalMs=${incrementalMs} heapDeltaMb=${heapDeltaMb.toFixed(1)} totalsWarnings=${totals.warnings} startupCalls=${startupCalls} startupUris=${startupUris} manualCalls=${manualCalls} manualUris=${manualUris} incrementalCalls=${incrementalCalls} incrementalUris=${incrementalUris}`,
        );
        api.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
