// The realtime bridge: editor-pushed diagnostics land in the store through
// the same ownership gate as scans. A realtime provider (capabilities.realtime)
// receives them via DiagnosticsAPI.reportEditorDiagnostics.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ProblemSeverity,
  ProviderHealth,
  type Diagnostic,
  type Provider,
  type Uri,
} from '@pe/core';
import { DiagnosticsAPI } from '../src/index.js';

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

function railtimeProvider(): Provider & { handle(u: Uri, d: readonly Diagnostic[]): void } {
  const latest = new Map<string, readonly Diagnostic[]>();
  const provider = {
    id: 'vscode',
    displayName: 'Editor',
    capabilities: {
      confidenceTier: 2,
      supportedConfigTypes: [],
      workspaceScan: false,
      incrementalScan: false,
      realtime: true,
      extensions: [],
      cost: 'cheap' as const,
    },
    configSchema: { type: 'object' },
    defaultConfig: {},
    handle: (u: Uri, d: readonly Diagnostic[]) => {
      if (d.length === 0) latest.delete(u.toString());
      else latest.set(u.toString(), d);
    },
    async healthCheck() {
      return { health: ProviderHealth.Ready };
    },
    async scan(context: { uris?: readonly Uri[] }) {
      return {
        changedUris: context.uris ?? [],
        files: (context.uris ?? [])
          .filter((u) => latest.has(u.toString()))
          .map((u) => ({ uri: u, diagnostics: latest.get(u.toString()) ?? [] })),
      };
    },
  };
  return provider;
}

function diag(message: string): Diagnostic {
  return { line: 0, column: 0, severity: ProblemSeverity.Error, message, source: 'editor' };
}

describe('DiagnosticsAPI.reportEditorDiagnostics', () => {
  let api: DiagnosticsAPI | undefined;

  afterEach(() => {
    api?.dispose();
    api = undefined;
  });

  it('applies editor diagnostics directly (fast path, no scan)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pe-rt-'));
    const file = join(ws, 'x.ts');
    const workspaceRoot = makeUri(ws);
    const uri = makeUri(file);
    try {
      api = new DiagnosticsAPI({ workspaceRoot, providers: [railtimeProvider()] });
      api.reportEditorDiagnostics(uri, [diag('red squiggle')]);
      expect(api.getProblems(uri).severity).toBe(ProblemSeverity.Error);
      expect(api.getOwners(uri)).toContain('vscode');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('no-ops when no realtime provider is registered', () => {
    const ws = mkdtempSync(join(tmpdir(), 'pe-rt2-'));
    const file = join(ws, 'x.ts');
    try {
      api = new DiagnosticsAPI({ workspaceRoot: makeUri(ws) });
      api.reportEditorDiagnostics(makeUri(file), [diag('ignored')]);
      expect(api.getProblems(makeUri(file)).errorCount).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
