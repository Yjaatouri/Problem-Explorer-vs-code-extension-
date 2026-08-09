// URI utilities for consistent key generation and comparison.
// All operations are pure string work on canonical URI strings — no `vscode`,
// no filesystem access. `Uri.toString()` is the canonical map key everywhere.

import type { Uri } from '../types/index.js';

/** Simple LRU cache (generic; used for URI key normalization) */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // mark as most recently used
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // evict least recently used
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

const uriKeyCache = new WeakMap<object, string>();

/**
 * Produce a canonical string key for a URI so equivalent URIs map to the
 * same cache entry regardless of Windows drive-letter casing or trailing slashes.
 *
 * Examples:
 * - `file:///C%3A/x/` and `file:///c%3A/x` → same key
 * - `file:///home/user/file.ts` and `file:///home/user/file.ts/` → same key
 */
export function normalizeUriKey(uri: Uri): string {
  const cacheable = typeof uri === 'object' && uri !== null;
  if (cacheable) {
    const cached = uriKeyCache.get(uri);
    if (cached !== undefined) {
      return cached;
    }
  }

  const input = uri.toString();
  let key = input;

  // Normalize Windows drive letter casing + encoding: file:///C%3A/..., file:///c%3A/...,
  // file:///C:/... all fold to file:///c%3A/... (the vscode.Uri canonical form).
  key = key.replace(
    /^(file:\/\/\/)([A-Za-z])(%3A|%3a|:)/,
    (_match: string, prefix: string, drive: string) => prefix + drive.toLowerCase() + '%3A',
  );

  // Strip trailing slashes (but never the scheme-root slash)
  while (key.length > 1 && key.endsWith('/') && !key.endsWith('://') && !key.endsWith(':///')) {
    key = key.slice(0, -1);
  }

  if (cacheable) {
    uriKeyCache.set(uri, key);
  }
  return key;
}

/**
 * Get the parent directory key from a normalized key.
 * Cheap string operation, no Uri allocation.
 */
export function getParentKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash <= 'file:///'.length) {
    return key; // at or above the scheme root — stays
  }
  return key.slice(0, lastSlash);
}

/** Clear the URI key cache (no-op: WeakMap entries die with their URIs). */
export function clearUriKeyCache(): void {
  // WeakMap — nothing to clear; kept for API compatibility.
}
