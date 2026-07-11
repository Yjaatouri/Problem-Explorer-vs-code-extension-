import { Uri } from 'vscode';
import { ProblemStatus, ProblemSeverity } from '../core/types';
import { PER_FOLDER_CACHE_LIMIT } from '../core/constants';
import { normalizeUriKey } from '../core/uriKey';
import { LruCache } from './lruCache';

/** Predicate that returns `true` when a URI should be excluded from the cache */
export type IgnorePredicate = (uri: Uri) => boolean;

/** Per-workspace-folder cache of file and folder diagnostics, backed by LRU eviction */
export class ProblemCache {
  private readonly folders: Map<string, LruCache<string, ProblemStatus>>;
  private readonly folderKeys: Set<string>;
  private ignorePredicate: IgnorePredicate | undefined;

  constructor() {
    this.folders = new Map();
    this.folderKeys = new Set();
  }

  /** Provide a function that filters URIs on insertion. Call with `undefined` to clear. */
  setIgnorePredicate(predicate: IgnorePredicate | undefined): void {
    this.ignorePredicate = predicate;
  }

  /** Look up a URI's cached status. Returns `undefined` if not cached or ignored. */
  get(uri: Uri, folderUri: Uri): ProblemStatus | undefined {
    const cache = this.folders.get(normalizeUriKey(folderUri));
    if (!cache) {
      return undefined;
    }
    return cache.get(normalizeUriKey(uri));
  }

  /**
   * Store a status for a URI under the given workspace folder.
   * Marks the entry as a file (not a folder aggregate).
   * @returns `true` if the value changed (or was newly inserted), `false` if unchanged or ignored.
   */
  set(uri: Uri, status: ProblemStatus, folderUri: Uri): boolean {
    if (this.ignorePredicate?.(uri)) {
      return false;
    }

    const uriKey = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folderUri);
    let cache = this.folders.get(folderKey);

    this.folderKeys.delete(uriKey);

    if (!cache) {
      cache = new LruCache<string, ProblemStatus>(PER_FOLDER_CACHE_LIMIT);
      this.folders.set(folderKey, cache);
      cache.set(uriKey, status);
      return true;
    }

    const old = cache.get(uriKey);
    if (old !== undefined && !hasChanged(old, status)) {
      return false;
    }

    cache.set(uriKey, status);
    return true;
  }

  /**
   * Store a folder aggregate status. Marks the entry as a folder
   * (so {@link getFileEntries} and {@link computeTotals} exclude it).
   * @returns `true` if the value changed, `false` otherwise.
   */
  setFolderAggregate(uri: Uri, status: ProblemStatus, folderUri: Uri): boolean {
    const uriKey = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folderUri);
    let cache = this.folders.get(folderKey);

    if (!cache) {
      cache = new LruCache<string, ProblemStatus>(PER_FOLDER_CACHE_LIMIT);
      this.folders.set(folderKey, cache);
      cache.set(uriKey, status);
      this.folderKeys.add(uriKey);
      return true;
    }

    const old = cache.get(uriKey);
    if (old !== undefined && !hasChanged(old, status)) {
      return false;
    }

    cache.set(uriKey, status);
    this.folderKeys.add(uriKey);
    return true;
  }

  /** `true` when the given cache key represents a folder aggregate (not a file entry). */
  private isFolderKey(key: string): boolean {
    return this.folderKeys.has(key);
  }

  /**
   * Iterate all **file** entries under a folder (excludes folder aggregates).
   * Each entry is re-parsed into a `Uri` object.
   */
  getFileEntries(folderUri: Uri): [Uri, ProblemStatus][] {
    const cache = this.folders.get(normalizeUriKey(folderUri));
    if (!cache) {
      return [];
    }
    const result: [Uri, ProblemStatus][] = [];
    for (const [uriStr, status] of cache.entries()) {
      if (!this.isFolderKey(uriStr)) {
        result.push([Uri.parse(uriStr), status]);
      }
    }
    return result;
  }

  /**
   * Remove all cached entries whose key starts with the given URI (the URI
   * itself and every descendant). Returns the list of removed URIs.
   */
  deletePrefix(uri: Uri, folderUri: Uri): Uri[] {
    const folderKey = normalizeUriKey(folderUri);
    const cache = this.folders.get(folderKey);
    if (!cache) return [];

    const prefix = normalizeUriKey(uri);
    const prefixSlash = prefix + '/';
    const removed: Uri[] = [];

    for (const [key] of cache.entries()) {
      if (key === prefix || key.startsWith(prefixSlash)) {
        cache.delete(key);
        this.folderKeys.delete(key);
        removed.push(Uri.parse(key));
      }
    }
    return removed;
  }

  /**
   * Move all cached entries under an old URI prefix to a new URI prefix
   * (handles both file renames and folder renames with descendants).
   * Returns the list of old URIs that were moved.
   */
  movePrefix(oldUri: Uri, newUri: Uri, folderUri: Uri): Uri[] {
    const folderKey = normalizeUriKey(folderUri);
    const cache = this.folders.get(folderKey);
    if (!cache) return [];

    const oldPrefix = normalizeUriKey(oldUri);
    const oldPrefixSlash = oldPrefix + '/';
    const newPrefix = normalizeUriKey(newUri);

    type Pending = { oldKey: string; newKey: string; status: ProblemStatus };
    const pending: Pending[] = [];

    for (const [key, status] of cache.entries()) {
      if (key === oldPrefix || key.startsWith(oldPrefixSlash)) {
        const newKey = key === oldPrefix ? newPrefix : newPrefix + key.slice(oldPrefix.length);
        pending.push({ oldKey: key, newKey, status });
      }
    }

    for (const { oldKey, newKey, status } of pending) {
      cache.delete(oldKey);
      this.folderKeys.delete(oldKey);
      cache.set(newKey, status);
    }

    return pending.map((p) => Uri.parse(p.oldKey));
  }

  /**
   * Remove a URI from its folder's cache. If it was a folder aggregate,
   * the folder-key marker is also removed.
   */
  delete(uri: Uri, folderUri: Uri): void {
    const key = normalizeUriKey(uri);
    this.folderKeys.delete(key);
    this.folders.get(normalizeUriKey(folderUri))?.delete(key);
  }

  /** Remove all cached entries across every workspace folder */
  clear(): void {
    this.folders.clear();
    this.folderKeys.clear();
  }

  /** Remove all entries for a single workspace folder */
  clearFolder(folderUri: Uri): void {
    const folderKey = normalizeUriKey(folderUri);
    const cache = this.folders.get(folderKey);
    if (cache) {
      for (const [key] of cache.entries()) {
        this.folderKeys.delete(key);
      }
    }
    this.folders.delete(folderKey);
  }

  /** Number of cached entries under a given folder */
  getFolderSize(folderUri: Uri): number {
    return this.folders.get(normalizeUriKey(folderUri))?.size ?? 0;
  }

  /**
   * Iterate all cached entries under a folder.
   * Each entry is re-parsed into a `Uri` object — prefer `get()` for single lookups.
   */
  getEntries(folderUri: Uri): [Uri, ProblemStatus][] {
    const cache = this.folders.get(normalizeUriKey(folderUri));
    if (!cache) {
      return [];
    }
    const result: [Uri, ProblemStatus][] = [];
    for (const [uriStr, status] of cache.entries()) {
      result.push([Uri.parse(uriStr), status]);
    }
    return result;
  }

  /** Aggregate all **file** entries across every workspace folder into a single status (excludes folder aggregates) */
  computeTotals(): ProblemStatus {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    let fileCount = 0;
    let maxSeverity = ProblemSeverity.None;

    for (const cache of this.folders.values()) {
      for (const [key, status] of cache.entries()) {
        if (this.isFolderKey(key)) {
          continue;
        }
        if (status.severity > maxSeverity) {
          maxSeverity = status.severity;
        }
        errorCount += status.errorCount;
        warningCount += status.warningCount;
        infoCount += status.infoCount;
        fileCount += status.fileCount;
      }
    }

    return {
      severity: maxSeverity,
      errorCount,
      warningCount,
      infoCount,
      fileCount,
    };
  }
}

function hasChanged(a: ProblemStatus, b: ProblemStatus): boolean {
  return (
    a.severity !== b.severity ||
    a.errorCount !== b.errorCount ||
    a.warningCount !== b.warningCount ||
    a.infoCount !== b.infoCount ||
    a.fileCount !== b.fileCount
  );
}
