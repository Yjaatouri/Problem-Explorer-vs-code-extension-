// TASK 9 — Large workspace baseline audit (§12).
// Synthetic workspaces of 1k / 5k / 10k files: index construction time,
// file counts, second-rebuild behavior (should detect zero changes), memory
// behavior, and one-file-change detection among many. Audit-first: numbers
// are recorded as baselines, not judged against invented targets.

import { WorkspaceIndex, fileUriFromPath } from '@pe/workspace-index';
import type { Uri } from '@pe/core';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

function record(key: string, value: unknown): void {
  console.log(`[AUDIT] ${key}=${value}`);
}

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Create `fileCount` files (mostly .ts, some .py) under a fresh temp dir. */
function makeWorkspace(fileCount: number): void {
  dir = mkdtempSync(join(tmpdir(), 'pe-scale-'));
  const buckets = 25;
  for (let i = 0; i < fileCount; i += 1) {
    const bucket = i % buckets;
    const bucketDir = join(dir, `mod${bucket}`);
    mkdirSync(bucketDir, { recursive: true });
    const ext = i % 10 === 0 ? '.py' : '.ts';
    writeFileSync(join(bucketDir, `f${i}${ext}`), `export const v${i} = ${i};\n`, 'utf8');
  }
}

function buildIndex(root: Uri): { index: WorkspaceIndex; elapsedMs: number; heapDeltaMb: number } {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = Date.now();
  const index = new WorkspaceIndex({ roots: [root] });
  index.load();
  index.rebuildDiagnostics();
  const elapsedMs = Date.now() - started;
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  return { index, elapsedMs, heapDeltaMb };
}

describe('Task9 audit — large workspace baseline', () => {
  for (const fileCount of [1000, 5000, 10_000]) {
    it(`${fileCount} files: index baseline, zero change events on re-walk`, () => {
      makeWorkspace(fileCount);
      const root = fileUriFromPath(dir);
      const { index, elapsedMs, heapDeltaMb } = buildIndex(root);

      expect(index.listFiles().length).toBe(fileCount);
      const pyCount = Math.ceil(fileCount / 10);
      expect(index.listFilesForExtension('py').length).toBe(pyCount);
      expect(index.listFilesForExtension('ts').length).toBe(fileCount - pyCount);

      let changeEvents = 0;
      const disposable = index.onDidChangeFiles(() => {
        changeEvents += 1;
      });
      // No files touched → second walk must detect zero changes (no rescan signal).
      const rewalkStart = Date.now();
      index.rebuildDiagnostics();
      const rewalkMs = Date.now() - rewalkStart;
      expect(changeEvents).toBe(0);
      disposable.dispose();

      record(
        `scale-${fileCount}`,
        `files=${fileCount} indexMs=${elapsedMs} rewalkMs=${rewalkMs} changeEvents=0 heapDeltaMb=${heapDeltaMb.toFixed(1)}`,
      );
    });
  }

  it('one changed file among 1000 produces exactly one change event', () => {
    makeWorkspace(1000);
    const root = fileUriFromPath(dir);
    const { index } = buildIndex(root);

    const target = index.listFilesForExtension('ts').at(-1)!.uri;
    utimesSync(target.fsPath, new Date(), new Date()); // bump mtime only
    const changes: string[] = [];
    const disposable = index.onDidChangeFiles((event) => {
      for (const change of event.changes) {
        changes.push(`${change.kind}:${change.uri.path}`);
      }
    });
    index.rebuildDiagnostics();
    disposable.dispose();

    expect(changes.length).toBe(1);
    expect(changes[0]).toBe(`change:${target.path}`);
    expect(index.getFile(target)?.modifiedMs).toBe(statSync(target.fsPath).mtimeMs);
  });
});
