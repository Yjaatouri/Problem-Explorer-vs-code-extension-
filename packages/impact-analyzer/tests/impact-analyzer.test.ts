// ImpactAnalyzer — event-to-plan rules (§5.8, §7.4). Real WorkspaceIndex over
// a temp directory so the mtime+size diff and project-root discovery are real.

import { ImpactAnalyzer } from '../src/impact-analyzer.js';
import { DiagnosticCache } from '../src/diagnostic-cache.js';
import { WorkspaceIndex, fileUriFromPath } from '@pe/workspace-index';
import type { ScanPlan, Uri } from '@pe/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
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

interface Harness {
  readonly root: Uri;
  readonly index: WorkspaceIndex;
  readonly cache: DiagnosticCache;
  readonly analyzer: ImpactAnalyzer;
  readonly plans: ScanPlan[][];
}

function setup(dir: string): Harness {
  const root = fileUriFromPath(dir);
  const index = new WorkspaceIndex({ roots: [root] });
  index.load();
  index.rebuildDiagnostics();
  const cache = new DiagnosticCache();
  const analyzer = new ImpactAnalyzer(index, cache, { debounceMs: 10, batchMs: 20 });
  const plans: ScanPlan[][] = [];
  analyzer.onPlans((batch) => plans.push([...batch]));
  return { root, index, cache, analyzer, plans };
}

let dir: string;
let harness: Harness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pe-analyzer-'));
  writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
  writeFileSync(join(dir, 'package.json'), '{}', 'utf8');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;', 'utf8');
  writeFileSync(join(dir, 'b.tsx'), 'export const b = 2;', 'utf8');
  writeFileSync(join(dir, 'c.py'), 'x = 1', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# hi', 'utf8');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'd.ts'), 'export const d = 4;', 'utf8');
  harness = setup(dir);
});

afterEach(() => {
  harness.analyzer.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('ImpactAnalyzer', () => {
  it('debounces and coalesces saves for the same URI', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    harness.analyzer.onFileChanged(a, 1000, 10);
    harness.analyzer.onFileChanged(a, 2000, 20);
    await waitFor(() => harness.plans.length === 1);
    const batch = harness.plans[0]!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      capability: 'typescript',
      scope: 'file',
      priority: 'save',
    });
    expect(batch[0]!.uris).toEqual([a]);
  });

  it('groups a batch into one plan per capability', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    const b = fileUriFromPath(join(dir, 'b.tsx'));
    harness.analyzer.onFileChanged(a, 1000, 10);
    harness.analyzer.onFileChanged(b, 1000, 10);
    await waitFor(() => harness.plans.length === 1);
    const plan = harness.plans[0]![0]!;
    expect(plan.capability).toBe('typescript');
    expect(plan.scope).toBe('file');
    expect(plan.uris).toHaveLength(2);
  });

  it('emits nothing for a no-op save (same mtime and size)', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    const entry = harness.index.getFile(a)!;
    harness.analyzer.onFileChanged(a, entry.modifiedMs, entry.size);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.plans.length).toBe(0);
  });

  it('removal invalidates the cache without emitting a plan', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    harness.cache.recordResult(a, 'tsc');
    harness.analyzer.onFileChanged(a, undefined, undefined);
    await waitFor(() => !harness.cache.hasFreshResult(a));
    expect(harness.plans.length).toBe(0);
  });

  it('maps package.json changes to a typescript + javascript workspace plan', async () => {
    const pkg = fileUriFromPath(join(dir, 'package.json'));
    harness.analyzer.onFileChanged(pkg, 1000, 10);
    await waitFor(() => harness.plans.length === 1);
    const batch = harness.plans[0]!;
    expect(batch).toHaveLength(2);
    expect(batch.map((plan) => plan.capability).sort()).toEqual(['javascript', 'typescript']);
    for (const plan of batch) {
      expect(plan.scope).toBe('workspace');
      expect(plan.uris.map((uri) => uri.fsPath)).toEqual([harness.root.fsPath]);
    }
  });

  it('maps tsconfig.json changes to a typescript-only workspace plan', async () => {
    const tsconfig = fileUriFromPath(join(dir, 'tsconfig.json'));
    harness.analyzer.onFileChanged(tsconfig, 1000, 10);
    await waitFor(() => harness.plans.length === 1);
    const batch = harness.plans[0]!;
    expect(batch).toHaveLength(1);
    expect(batch[0]!.capability).toBe('typescript');
    expect(batch[0]!.scope).toBe('workspace');
  });

  it('config change invalidates the whole project-root prefix', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    const d = fileUriFromPath(join(dir, 'sub', 'd.ts'));
    harness.cache.recordResult(a, 'tsc');
    harness.cache.recordResult(d, 'tsc');
    const pkg = fileUriFromPath(join(dir, 'package.json'));
    harness.analyzer.onFileChanged(pkg, 1000, 10);
    await waitFor(() => harness.plans.length === 1);
    expect(harness.cache.hasFreshResult(a)).toBe(false);
    expect(harness.cache.hasFreshResult(d)).toBe(false);
  });

  it('unknown extensions never wake the scheduler', async () => {
    const readme = fileUriFromPath(join(dir, 'README.md'));
    harness.analyzer.onFileChanged(readme, 1000, 10);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.plans.length).toBe(0);
  });

  it('keeps source and config work in separate plans', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    const pkg = fileUriFromPath(join(dir, 'package.json'));
    harness.analyzer.onFileChanged(a, 1000, 10);
    harness.analyzer.onFileChanged(pkg, 1000, 10);
    await waitFor(() => harness.plans.length === 1);
    const batch = harness.plans[0]!;
    expect(batch).toHaveLength(3);
    expect(batch.filter((plan) => plan.scope === 'file')).toHaveLength(1);
    expect(batch.filter((plan) => plan.scope === 'workspace')).toHaveLength(2);
    const filePlan = batch.find((plan) => plan.scope === 'file')!;
    expect(filePlan.capability).toBe('typescript');
    expect(filePlan.uris).toEqual([a]);
  });

  it('onWorkspaceChanged emits startup plans for every source capability', async () => {
    harness.cache.recordResult(fileUriFromPath(join(dir, 'a.ts')), 'tsc');
    harness.analyzer.onWorkspaceChanged();
    expect(harness.cache.size).toBe(0);
    expect(harness.plans.length).toBe(1);
    const batch = harness.plans[0]!;
    expect(batch.map((plan) => plan.capability).sort()).toEqual(['python', 'typescript']);
    for (const plan of batch) {
      expect(plan.priority).toBe('startup');
      expect(plan.scope).toBe('workspace');
    }
  });

  it('requestScan bypasses the no-op diff and marks plans manual', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    harness.cache.recordResult(a, 'tsc');
    harness.analyzer.requestScan([a], 'manual');
    expect(harness.plans.length).toBe(1);
    const plan = harness.plans[0]![0]!;
    expect(plan.priority).toBe('manual');
    expect(plan.uris).toEqual([a]);
  });

  it('requestScan without uris covers the whole workspace', () => {
    harness.analyzer.requestScan(undefined, 'manual');
    expect(harness.plans.length).toBe(1);
    const batch = harness.plans[0]!;
    // file plans for source capabilities + workspace plans for the config files
    expect(batch.map((plan) => plan.capability).sort()).toEqual([
      'javascript',
      'python',
      'typescript',
      'typescript',
    ]);
    const typescript = batch.find(
      (plan) => plan.capability === 'typescript' && plan.scope === 'file',
    )!;
    expect(typescript.uris).toHaveLength(3); // a.ts, b.tsx, sub/d.ts
    const configPlan = batch.find(
      (plan) => plan.capability === 'typescript' && plan.scope === 'workspace',
    )!;
    expect(configPlan.uris).toHaveLength(1);
  });

  it('plans only stale files owned by the changed provider', () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    const b = fileUriFromPath(join(dir, 'b.tsx'));
    const c = fileUriFromPath(join(dir, 'c.py'));
    harness.index.markScanned(a, 'tsc');
    harness.index.markScanned(b, 'tsc');
    harness.cache.recordResult(b, 'tsc'); // fresh → not re-planned
    harness.index.markScanned(c, 'ruff');
    harness.analyzer.onProviderHealthChanged('tsc');
    expect(harness.plans.length).toBe(1);
    const plan = harness.plans[0]![0]!;
    expect(plan.capability).toBe('typescript');
    expect(plan.uris.map((uri) => uri.fsPath)).toEqual([a.fsPath]);
  });

  it('a save invalidates the cache: changed files are planned even when previously fresh', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    const b = fileUriFromPath(join(dir, 'b.tsx'));
    harness.cache.recordResult(a, 'tsc'); // previously scanned → fresh
    harness.analyzer.onFileChanged(a, 1000, 10);
    harness.analyzer.onFileChanged(b, 1000, 10);
    await waitFor(() => harness.plans.length === 1);
    const plan = harness.plans[0]![0]!;
    expect(plan.uris).toHaveLength(2); // the save IS the invalidation event
    expect(harness.cache.hasFreshResult(a)).toBe(false);
    expect(harness.cache.hasFreshResult(b)).toBe(false);
  });

  it('dispose drops pending work and ignores later events', async () => {
    const a = fileUriFromPath(join(dir, 'a.ts'));
    harness.analyzer.onFileChanged(a, 1000, 10);
    harness.analyzer.dispose();
    harness.analyzer.onFileChanged(a, 1000, 10);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.plans.length).toBe(0);
  });
});
