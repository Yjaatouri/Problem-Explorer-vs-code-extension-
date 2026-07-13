import { Uri } from 'vscode';
import { ProblemState, ProblemSeverity } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';
import { forensicLog } from '../forensicLogger';

/** Predicate that returns `true` when a URI should be excluded from the cache */
export type IgnorePredicate = (uri: Uri) => boolean;

/** Per-workspace-folder cache of file and folder diagnostics. No LRU eviction. */
export class ProblemCache {
  private readonly folders: Map<string, Map<string, ProblemState>>;
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
  get(uri: Uri, folderUri: Uri): ProblemState | undefined {
    const cache = this.folders.get(normalizeUriKey(folderUri));
    if (!cache) {
      return undefined;
    }
    return cache.get(normalizeUriKey(uri));
  }

  /**
   * Store a status for a URI under the given workspace folder.
   * If the status has `None` severity the entry is deleted instead (no-op
   * when nothing was cached). Marks the entry as a file (not a folder aggregate).
   * @returns `true` if the value changed (or was newly inserted), `false` if unchanged or ignored.
   */
  set(uri: Uri, status: ProblemState, folderUri: Uri): boolean {
    const uriKey = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folderUri);
    const now = new Date().toISOString();

    // FORENSIC: Log BEFORE state
    const cacheBefore = this.folders.get(folderKey);
    const oldStatus = cacheBefore?.get(uriKey);
    const hadBefore = cacheBefore?.has(uriKey) ?? false;

    if (this.ignorePredicate?.(uri)) {
      // Still log ignored case
      if (hadBefore) {
        forensicLog(`[FORENSIC:Step3] cache.set IGNORED: uriKey=${uriKey} folderKey=${folderKey} time=${now} oldSeverity=${oldStatus?.severity} ignored=true`);
      }
      return false;
    }

    // Don't store entries that have no problems
    if (status.severity === ProblemSeverity.None) {
      this.folderKeys.delete(uriKey);
      const cache = this.folders.get(folderKey);
      const had = cache?.has(uriKey) ?? false;
      cache?.delete(uriKey);
      if (had || hadBefore) {
        forensicLog(`[FORENSIC:Step3] cache.set DELETE None: uriKey=${uriKey} folderKey=${folderKey} time=${now} hadBefore=${hadBefore} oldSeverity=${oldStatus?.severity} newSeverity=None`);
      }
      return had;
    }

    let cache = this.folders.get(folderKey);
    this.folderKeys.delete(uriKey);

    if (!cache) {
      cache = new Map();
      this.folders.set(folderKey, cache);
      cache.set(uriKey, status);
      forensicLog(`[FORENSIC:Step3] cache.set INSERT NEW: uriKey=${uriKey} folderKey=${folderKey} time=${now} severity=${status.severity} err=${status.errorCount} warn=${status.warningCount} info=${status.infoCount} fileCount=${status.fileCount} oldSeverity=none`);
      return true;
    }

    const old = cache.get(uriKey);
    if (old !== undefined && !hasChanged(old, status)) {
      forensicLog(`[FORENSIC:Step3] cache.set NO CHANGE: uriKey=${uriKey} folderKey=${folderKey} time=${now} severity=${status.severity}`);
      return false;
    }

    cache.set(uriKey, status);
    forensicLog(`[FORENSIC:Step3] cache.set UPDATE: uriKey=${uriKey} folderKey=${folderKey} time=${now} severity=${status.severity} err=${status.errorCount} warn=${status.warningCount} info=${status.infoCount} fileCount=${status.fileCount} oldSeverity=${old?.severity ?? 'none'}`);
    return true;
  }

  /**
   * Store a folder aggregate status. Marks the entry as a folder
   * (so {@link getFileEntries} and {@link computeTotals} exclude it).
   * A `None`-severity aggregate is deleted instead (no entry when the
   * folder has no problems).
   * @returns `true` if the value changed, `false` otherwise.
   */
  setFolderAggregate(uri: Uri, status: ProblemState, folderUri: Uri): boolean {
    const uriKey = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folderUri);
    const now = new Date().toISOString();

    // Don't store folder aggregates that have no problems
    if (status.severity === ProblemSeverity.None) {
      this.folderKeys.delete(uriKey);
      const cache = this.folders.get(folderKey);
      const had = cache?.has(uriKey) ?? false;
      cache?.delete(uriKey);
      if (had) {
        console.log(`[PE ${now}] [FORENSIC:Step3] setFolderAggregate DELETE None: uriKey=${uriKey} folderKey=${folderKey} time=${now} oldSeverity=none`);
      }
      return had;
    }

    let cache = this.folders.get(folderKey);
    const old = cache?.get(uriKey);

    if (cache) {
      if (old !== undefined && !hasChanged(old, status)) {
        console.log(`[PE ${now}] [FORENSIC:Step3] setFolderAggregate NO CHANGE: uriKey=${uriKey} folderKey=${folderKey} time=${now} severity=${status.severity}`);
        return false;
      }
    } else {
      cache = new Map();
      this.folders.set(folderKey, cache);
    }

    cache.set(uriKey, status);
    this.folderKeys.add(uriKey);
    console.log(`[PE ${now}] [FORENSIC:Step3] setFolderAggregate ${old ? 'UPDATE' : 'INSERT'}: uriKey=${uriKey} folderKey=${folderKey} time=${now} severity=${status.severity} err=${status.errorCount} warn=${status.warningCount} info=${status.infoCount} fileCount=${status.fileCount} oldSeverity=${old?.severity ?? 'none'}`);
    return true;
  }

  /** `true` when the given cache key represents a folder aggregate (not a file entry). */
  private isFolderKey(key: string): boolean {
    return this.folderKeys.has(key);
  }

  /**
   * Iterate all **file** entries under a folder (excludes folder aggregates).
   * Returns raw normalized-URI string keys to avoid the cost of `Uri.parse`.
   * Prefer this over {@link getFileEntries} in hot paths.
   */
  getRawFileEntries(folderUri: Uri): [string, ProblemState][] {
    const cache = this.folders.get(normalizeUriKey(folderUri));
    if (!cache) return [];
    const result: [string, ProblemState][] = [];
    for (const [key, status] of cache) {
      if (!this.isFolderKey(key)) {
        result.push([key, status]);
      }
    }
    return result;
  }

  /**
   * Iterate all cached entries under a folder (including folder aggregates).
   * Returns raw normalized-URI string keys to avoid the cost of `Uri.parse`.
   */
  getRawEntries(folderUri: Uri): [string, ProblemState][] {
    const cache = this.folders.get(normalizeUriKey(folderUri));
    if (!cache) return [];
    return Array.from(cache);
  }

  /**
   * Iterate all **file** entries under a folder (excludes folder aggregates).
   * Each entry is re-parsed into a `Uri` object — prefer {@link getRawFileEntries} in hot paths.
   */
  getFileEntries(folderUri: Uri): [Uri, ProblemState][] {
    return this.getRawFileEntries(folderUri).map(([k, v]) => [Uri.parse(k), v]);
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

    for (const [key] of cache) {
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

    type Pending = { oldKey: string; newKey: string; status: ProblemState };
    const pending: Pending[] = [];

    for (const [key, status] of cache) {
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
   * @returns `true` if an entry existed and was removed, `false` otherwise.
   */
  delete(uri: Uri, folderUri: Uri): boolean {
    const key = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folderUri);
    const cache = this.folders.get(folderKey);
    const had = cache?.has(key) ?? false;
    this.folderKeys.delete(key);
    cache?.delete(key);
    if (had) {
      forensicLog(`[FORENSIC:Step3] cache.DELETE: uriKey=${key} folderKey=${folderKey} time=${new Date().toISOString()}`);
    }
    return had;
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
      for (const [key] of cache) {
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
   * Each entry is re-parsed into a `Uri` object — prefer {@link getRawEntries} for hot paths.
   */
  getEntries(folderUri: Uri): [Uri, ProblemState][] {
    return this.getRawEntries(folderUri).map(([k, v]) => [Uri.parse(k), v]);
  }

  /** Aggregate all **file** entries across every workspace folder into a single status (excludes folder aggregates) */
  computeTotals(): ProblemState {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    let fileCount = 0;
    let maxSeverity = ProblemSeverity.None;

    for (const cache of this.folders.values()) {
      for (const [key, status] of cache) {
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

function hasChanged(a: ProblemState, b: ProblemState): boolean {
  return (
    a.severity !== b.severity ||
    a.errorCount !== b.errorCount ||
    a.warningCount !== b.warningCount ||
    a.infoCount !== b.infoCount ||
    a.fileCount !== b.fileCount
  );
}
