import { Uri } from 'vscode';
import { ProblemStatus } from '../core/types';
import { PER_FOLDER_CACHE_LIMIT } from '../core/constants';
import { LruCache } from './lruCache';

/** Predicate that returns `true` when a URI should be excluded from the cache */
export type IgnorePredicate = (uri: Uri) => boolean;

/** Per-workspace-folder cache of file and folder diagnostics, backed by LRU eviction */
export class ProblemCache {
  private readonly folders: Map<string, LruCache<string, ProblemStatus>>;
  private ignorePredicate: IgnorePredicate | undefined;

  constructor() {
    this.folders = new Map();
  }

  /** Provide a function that filters URIs on insertion. Call with `undefined` to clear. */
  setIgnorePredicate(predicate: IgnorePredicate | undefined): void {
    this.ignorePredicate = predicate;
  }

  /** Look up a URI's cached status. Returns `undefined` if not cached or ignored. */
  get(uri: Uri, folderUri: Uri): ProblemStatus | undefined {
    const cache = this.folders.get(folderUri.toString());
    if (!cache) {
      return undefined;
    }
    return cache.get(uri.toString());
  }

  /**
   * Store a status for a URI under the given workspace folder.
   * @returns `true` if the value changed (or was newly inserted), `false` if unchanged or ignored.
   */
  set(uri: Uri, status: ProblemStatus, folderUri: Uri): boolean {
    if (this.ignorePredicate?.(uri)) {
      return false;
    }

    const uriKey = uri.toString();
    const folderKey = folderUri.toString();
    let cache = this.folders.get(folderKey);

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

  /** Remove a URI from its folder's cache */
  delete(uri: Uri, folderUri: Uri): void {
    this.folders.get(folderUri.toString())?.delete(uri.toString());
  }

  /** Remove all cached entries across every workspace folder */
  clear(): void {
    this.folders.clear();
  }

  /** Remove all entries for a single workspace folder */
  clearFolder(folderUri: Uri): void {
    this.folders.delete(folderUri.toString());
  }

  /** Number of cached entries under a given folder */
  getFolderSize(folderUri: Uri): number {
    return this.folders.get(folderUri.toString())?.size ?? 0;
  }

  /**
   * Iterate all cached entries under a folder.
   * Each entry is re-parsed into a `Uri` object — prefer `get()` for single lookups.
   */
  getEntries(folderUri: Uri): [Uri, ProblemStatus][] {
    const cache = this.folders.get(folderUri.toString());
    if (!cache) {
      return [];
    }
    const result: [Uri, ProblemStatus][] = [];
    for (const [uriStr, status] of cache.entries()) {
      result.push([Uri.parse(uriStr), status]);
    }
    return result;
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
