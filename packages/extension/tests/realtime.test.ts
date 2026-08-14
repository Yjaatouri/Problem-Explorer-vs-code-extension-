import { describe, expect, it } from 'vitest';

import type { Diagnostic, Uri } from '@pe/api';

import { wantsIn } from '../src/realtime.js';
import { RealtimeDiagnosticsBridge } from '../src/realtime.js';
import type { EngineApi } from '../src/engine.js';

const root: Uri = {
  scheme: 'file',
  authority: '',
  path: '/repo',
  fsPath: 'C:/repo',
  toString: () => 'file:///repo',
  with: () => root,
};

const fileUri = (path: string): Uri => ({
  scheme: 'file',
  authority: '',
  path,
  fsPath: path.replace(/^\/repo/, 'C:/repo'),
  toString: () => `file:///repo${path.slice('/repo'.length)}`,
  with: () => ({}),
});

const neverIgnored = () => false;

describe('wantsIn', () => {
  it('accepts in-workspace file URIs', () => {
    expect(wantsIn(fileUri('/repo/src/a.ts'), root, neverIgnored)).toBe(true);
  });

  it('rejects out-of-workspace files', () => {
    expect(wantsIn(fileUri('/other/b.ts'), root, neverIgnored)).toBe(false);
  });

  it('rejects non-file schemes', () => {
    expect(wantsIn({ ...fileUri('/repo/a.ts'), scheme: 'untitled' }, root, neverIgnored)).toBe(
      false,
    );
  });

  it('rejects ignored files', () => {
    expect(wantsIn(fileUri('/repo/node_modules/x.js'), root, () => true)).toBe(false);
  });

  it('accepts the workspace root itself', () => {
    expect(wantsIn(root, root, neverIgnored)).toBe(true);
  });
});

describe('RealtimeDiagnosticsBridge', () => {
  it('pushes mapped diagnostics into the engine', () => {
    const pushed: { uri: Uri; diagnostics: Diagnostic[] }[] = [];
    const handled: { uri: Uri; diagnostics: Diagnostic[] }[] = [];
    const engine = {
      api: { reportEditorDiagnostics: (uri: Uri, diags: Diagnostic[]) => pushed.push({ uri, diagnostics: diags }) },
      realtime: { handle: (uri: Uri, diags: Diagnostic[]) => handled.push({ uri, diagnostics: diags }) },
    } as unknown as EngineApi;

    const bridge = new RealtimeDiagnosticsBridge(
      () => engine,
      root,
      {
        getDiagnostics: () => [
          {
            severity: 1 as const,
            message: 'no-unused-vars',
            source: 'eslint',
            range: { start: { line: 0, character: 2 } },
          },
        ],
        getAllDiagnostics: () => [],
      },
      neverIgnored,
      undefined,
    );

    bridge.pushUri(fileUri('/repo/src/a.ts'));

    expect(handled).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.diagnostics[0]).toMatchObject({
      line: 0,
      column: 2,
      severity: 2,
      message: 'no-unused-vars',
    });
  });

  it('does nothing when no engine is live', () => {
    const bridge = new RealtimeDiagnosticsBridge(
      () => undefined,
      root,
      {
        getDiagnostics: () => [{ severity: 0 as const, message: 'x', range: { start: { line: 0, character: 0 } } }],
        getAllDiagnostics: () => [],
      },
      neverIgnored,
      undefined,
    );
    expect(() => bridge.pushUri(fileUri('/repo/a.ts'))).not.toThrow();
  });

  it('syncAll backfills every in-scope diagnostic exactly once, skipping the rest', () => {
    const pushed: { uri: Uri; diagnostics: Diagnostic[] }[] = [];
    const handled: { uri: Uri; diagnostics: Diagnostic[] }[] = [];
    const engine = {
      api: { reportEditorDiagnostics: (uri: Uri, diags: Diagnostic[]) => pushed.push({ uri, diagnostics: diags }) },
      realtime: { handle: (uri: Uri, diags: Diagnostic[]) => handled.push({ uri, diagnostics: diags }) },
    } as unknown as EngineApi;

    const ignoredIfNodeModules = (uri: { fsPath: string }): boolean =>
      uri.fsPath.includes('node_modules');
    const diag = (message: string) => ({
      severity: 0 as const,
      message,
      source: 'vscode',
      range: { start: { line: 0, character: 0 } },
    });

    const bridge = new RealtimeDiagnosticsBridge(
      () => engine,
      root,
      {
        getDiagnostics: () => [],
        getAllDiagnostics: () => [
          [fileUri('/repo/src/a.ts'), [diag('in scope')]],
          [fileUri('/repo/node_modules/x.js'), [diag('ignored')]],
          [fileUri('/other/b.ts'), [diag('outside')]],
          [{ ...fileUri('/repo/untitled.ts'), scheme: 'untitled' }, [diag('not a file')]],
        ],
      },
      ignoredIfNodeModules,
      undefined,
    );

    bridge.syncAll();

    expect(handled).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect(handled[0]!.uri.toString()).toBe(fileUri('/repo/src/a.ts').toString());
    expect(pushed[0]!.diagnostics[0]).toMatchObject({ line: 0, column: 0, severity: 3 });
  });

  it('syncAll is a no-op when no engine is live', () => {
    const bridge = new RealtimeDiagnosticsBridge(
      () => undefined,
      root,
      {
        getDiagnostics: () => [],
        getAllDiagnostics: () => [[fileUri('/repo/src/a.ts'), []]],
      },
      neverIgnored,
      undefined,
    );
    expect(() => bridge.syncAll()).not.toThrow();
  });
});