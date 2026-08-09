import { describe, expect, it } from 'vitest';

import { ProviderHealth, ScanType, type Diagnostic, type Uri } from '@pe/provider-sdk';
import { RealtimeDiagnosticsProvider } from '../src/index.js';

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

const a = makeUri('/repo/a.ts');
const b = makeUri('/repo/b.ts');

function diag(message: string): Diagnostic {
  return { line: 0, column: 0, severity: 2, message, source: 'typescript' };
}

describe('RealtimeDiagnosticsProvider', () => {
  it('healthCheck is always Ready', async () => {
    const ok = await new RealtimeDiagnosticsProvider().healthCheck();
    expect(ok.health).toBe(ProviderHealth.Ready);
  });

  it('returns pushed snapshots for scanned files and nothing for others', async () => {
    const provider = new RealtimeDiagnosticsProvider();
    provider.handle(a, [diag('boom')]);
    provider.handle(b, []); // empty clears

    const result = await provider.scan({ type: ScanType.Save, trigger: 'save', uris: [a, b] });
    const first = result.files?.[0];
    expect(result.files).toHaveLength(1);
    expect(first?.uri.path.endsWith('a.ts')).toBe(true);
    expect(first?.diagnostics[0]?.message).toBe('boom');
    expect(result.changedUris).toEqual([a, b]);
  });

  it('empty scan returns zero files without error', async () => {
    const provider = new RealtimeDiagnosticsProvider();
    const result = await provider.scan({ type: ScanType.Manual, trigger: 'manual', uris: [] });
    expect(result.files).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  it('clear() drops all snapshots', async () => {
    const provider = new RealtimeDiagnosticsProvider();
    provider.handle(a, [diag('x')]);
    provider.clear();
    const result = await provider.scan({ type: ScanType.Manual, trigger: 'manual', uris: [a] });
    expect(result.files).toBeUndefined();
  });
});
