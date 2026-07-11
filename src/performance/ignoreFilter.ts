import { Uri } from 'vscode';
import { Minimatch } from 'minimatch';
import { DEFAULT_IGNORE_PATTERNS } from '../core/constants';

const compiledCache = new Map<string, Minimatch>();

function getMatcher(pattern: string): Minimatch {
  let m = compiledCache.get(pattern);
  if (!m) {
    m = new Minimatch(pattern, { dot: true });
    compiledCache.set(pattern, m);
  }
  return m;
}

/** Check whether a URI matches any of the given ignore glob patterns (defaults to `DEFAULT_IGNORE_PATTERNS`). Non-`file` URIs are never ignored. */
export function isIgnored(uri: Uri, patterns?: string[]): boolean {
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
export function precompilePatterns(patterns: string[]): void {
  for (let i = 0; i < patterns.length; i++) {
    getMatcher(patterns[i]);
  }
}

/** Clear the compiled pattern cache (for test isolation). */
export function clearPatternCache(): void {
  compiledCache.clear();
}
