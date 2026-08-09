import { afterEach, describe, expect, it } from 'vitest';

import { clearPatternCache, isIgnored, precompilePatterns } from '../src/ignore.js';

const uri = (fsPath: string, scheme = 'file') => ({
  scheme,
  fsPath,
  path: fsPath.replace(/\\/g, '/'),
  toString: () => `${scheme}://${fsPath.replace(/\\/g, '/')}`,
});

afterEach(() => {
  clearPatternCache();
});

describe('isIgnored', () => {
  it('defaults to the standard ignore patterns', () => {
    expect(isIgnored(uri('C:\\repo\\node_modules\\pkg\\a.js'))).toBe(true);
    expect(isIgnored(uri('C:\\repo\\dist\\bundle.js'))).toBe(true);
    expect(isIgnored(uri('/home/me/repo/src/a.ts'))).toBe(false);
  });

  it('honors supplied patterns', () => {
    const patterns = ['**/generated/**'];
    expect(isIgnored(uri('/repo/generated/a.ts'), patterns)).toBe(true);
    expect(isIgnored(uri('/repo/src/a.ts'), patterns)).toBe(false);
  });

  it('never ignores non-file schemes', () => {
    expect(isIgnored(uri('untitled:a', 'untitled'))).toBe(false);
  });

  it('no patterns = nothing ignored', () => {
    expect(isIgnored(uri('/repo/node_modules/x.js'), [])).toBe(false);
  });

  it('precompile warms the cache', () => {
    precompilePatterns(['**/node_modules/**']);
    expect(isIgnored(uri('/repo/node_modules/x.js'))).toBe(true);
  });
});