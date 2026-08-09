import { DiagnosticCache, DEFAULT_TTL_MS } from '../src/diagnostic-cache.js';
import type { Uri } from '@pe/core';
import { describe, expect, it } from 'vitest';

function testUri(fsPath: string): Uri {
  const normalized = fsPath.replace(/\\/g, '/');
  return {
    scheme: 'file',
    authority: '',
    path: normalized,
    fsPath,
    toString: () => `file:///${normalized}`,
    with: (change) => testUri(change.path ?? fsPath),
  };
}

const FILE_A = testUri('/home/user/proj/src/app.ts');
const FILE_B = testUri('/home/user/proj/src/util.ts');

describe('DiagnosticCache', () => {
  it('is fresh after recordResult', () => {
    const cache = new DiagnosticCache();
    expect(cache.hasFreshResult(FILE_A)).toBe(false);
    cache.recordResult(FILE_A, 'tsc');
    expect(cache.hasFreshResult(FILE_A)).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('default TTL is 24 hours', () => {
    expect(DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('expires after the TTL (safety net only)', () => {
    let now = 1_000_000;
    const cache = new DiagnosticCache({ ttlMs: 100, now: () => now });
    cache.recordResult(FILE_A, 'tsc');
    now += 99;
    expect(cache.hasFreshResult(FILE_A)).toBe(true);
    now += 2;
    expect(cache.hasFreshResult(FILE_A)).toBe(false);
  });

  it('invalidate removes freshness (event-driven path)', () => {
    const cache = new DiagnosticCache();
    cache.recordResult(FILE_A, 'tsc');
    cache.invalidate(FILE_A);
    expect(cache.hasFreshResult(FILE_A)).toBe(false);
  });

  it('invalidateAll clears every entry', () => {
    const cache = new DiagnosticCache();
    cache.recordResult(FILE_A, 'tsc');
    cache.recordResult(FILE_B, 'eslint');
    cache.invalidateAll();
    expect(cache.size).toBe(0);
    expect(cache.hasFreshResult(FILE_A)).toBe(false);
    expect(cache.hasFreshResult(FILE_B)).toBe(false);
  });

  it('a different config fingerprint makes results stale', () => {
    const cache = new DiagnosticCache();
    cache.recordResult(FILE_A, 'tsc', { fingerprint: 'config-v1' });
    expect(cache.hasFreshResult(FILE_A, 'config-v1')).toBe(true);
    expect(cache.hasFreshResult(FILE_A, 'config-v2')).toBe(false);
  });

  it('a null fingerprint check does not invalidate a fingerprinted entry', () => {
    const cache = new DiagnosticCache();
    cache.recordResult(FILE_A, 'tsc', { fingerprint: 'config-v1' });
    expect(cache.hasFreshResult(FILE_A)).toBe(true);
  });

  it('clear removes all entries', () => {
    const cache = new DiagnosticCache();
    cache.recordResult(FILE_A, 'tsc');
    cache.recordResult(FILE_B, 'eslint');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.hasFreshResult(FILE_A)).toBe(false);
  });
});
