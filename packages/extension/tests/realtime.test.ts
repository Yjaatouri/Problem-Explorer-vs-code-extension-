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
      { getDiagnostics: () => [{ severity: 0 as const, message: 'x', range: { start: { line: 0, character: 0 } } }] },
      neverIgnored,
      undefined,
    );
    expect(() => bridge.pushUri(fileUri('/repo/a.ts'))).not.toThrow();
  });
});