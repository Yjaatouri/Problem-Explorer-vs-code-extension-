import { Minimatch } from 'minimatch';

import { DEFAULT_IGNORE_PATTERNS } from './constants.js';

export interface FileLikeUri {
  readonly scheme: string;
  readonly fsPath: string;
}

const compiledCache = new Map<string, Minimatch>();

function getMatcher(pattern: string): Minimatch {
  let m = compiledCache.get(pattern);
  if (!m) {
    m = new Minimatch(pattern, { dot: true });
    compiledCache.set(pattern, m);
  }
  return m;
}

/** Check whether a URI matches any ignore glob (defaults to `DEFAULT_IGNORE_PATTERNS`). Non-`file` URIs are never ignored. */
export function isIgnored(uri: FileLikeUri, patterns?: readonly string[]): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }

  const list = patterns ?? DEFAULT_IGNORE_PATTERNS;
  if (list.length === 0) {
    return false;
  }

  const path = uri.fsPath.replace(/\\/g, '/');
  return list.some((p) => getMatcher(p).match(path));
}

/** Pre-compile the given patterns so they are ready for repeated `isIgnored` calls. */
export function precompilePatterns(patterns: readonly string[]): void {
  for (const pattern of patterns) {
    getMatcher(pattern);
  }
}

/** Clear the compiled pattern cache (for test isolation). */
export function clearPatternCache(): void {
  compiledCache.clear();
}