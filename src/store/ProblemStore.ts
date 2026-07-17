import { Event, EventEmitter, Uri } from 'vscode';
import { ProblemStoreChange } from '../models/ProblemStoreChange';
import { ProblemState, ProblemSeverity } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';
import { debugLog } from '../core/debug';

export class ProblemStore {
  private readonly storage = new Map<string, ProblemState>();
  private readonly folderKeys = new Set<string>();
  private readonly ownerByKey = new Map<string, string>();
  private readonly providerPriorities = new Map<string, number>();
  private readonly _onDidChange = new EventEmitter<ProblemStoreChange>();
  private batchDepth = 0;
  private version = 0;

  // Running totals for O(1) computeTotals()
  private _runningTotals: ProblemState = this._zeroTotals();

  readonly onDidChange: Event<ProblemStoreChange> = this._onDidChange.event;

  getVersion(): number {
    return this.version;
  }

  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    if (this.batchDepth === 0) return;
    this.batchDepth--;
    if (this.batchDepth === 0) {
      this._onDidChange.fire({ kind: 'batch' });
    }
  }

  set(uri: Uri, state: ProblemState, providerName?: string): boolean {
    const ts = Date.now();
    const key = normalizeUriKey(uri);
    debugLog(`[AUDIT:${ts}] STORE.set() ENTER uri=${uri.fsPath} provider=${providerName ?? 'unknown'} severity=${state.severity} errors=${state.errorCount} warnings=${state.warningCount}`);
    if (providerName !== undefined) {
      const currentOwner = this.ownerByKey.get(key);
      if (currentOwner !== undefined) {
        const currentPriority = this.providerPriorities.get(currentOwner) ?? -1;
        const newPriority = this.providerPriorities.get(providerName) ?? -1;
        if (newPriority < currentPriority) {
          debugLog(`[AUDIT:${Date.now()}] STORE.set() REJECTED — lower priority provider="${providerName}" (pri=${newPriority}) < currentOwner="${currentOwner}" (pri=${currentPriority}) key=${key}`);
          return false;
        }
        debugLog(`[AUDIT:${Date.now()}] STORE.set() priority OK — provider="${providerName}" (pri=${newPriority}) >= currentOwner="${currentOwner}" (pri=${currentPriority})`);
      } else {
        debugLog(`[AUDIT:${Date.now()}] STORE.set() no current owner for key=${key} — provider="${providerName}" will own it`);
      }
    }
    const old = this.storage.get(key);
    if (old !== undefined && !this.hasChanged(old, state)) {
      debugLog(`[AUDIT:${Date.now()}] STORE.set() SKIPPED — unchanged state key=${key} oldSeverity=${old.severity} newSeverity=${state.severity} oldErrors=${old.errorCount} newErrors=${state.errorCount}`);
      return false;
    }
    const existed = old !== undefined;

    // Update running totals
    if (existed) {
      this._subtractFromTotals(old);
    }
    this._addToTotals(state);

    this.storage.set(key, state);
    this.folderKeys.delete(key);
    if (providerName !== undefined) {
      this.ownerByKey.set(key, providerName);
    }
    this.version++;
    debugLog(`[AUDIT:${Date.now()}] STORE.set() ${existed ? 'UPDATED' : 'ADDED'} key=${key} provider=${providerName ?? 'unknown'} severity=${state.severity} errors=${state.errorCount} warnings=${state.warningCount}`);
    if (this.batchDepth === 0) {
      debugLog(`[AUDIT:${Date.now()}] STORE.set() firing _onDidChange(${existed ? 'updated' : 'added'}) uri=${uri.fsPath}`);
      this._onDidChange.fire(existed ? { kind: 'updated', uri } : { kind: 'added', uri });
    } else {
      debugLog(`[AUDIT:${Date.now()}] STORE.set() _onDidChange DEFERRED — batchDepth=${this.batchDepth}`);
    }
    return true;
  }

  setFolderAggregate(uri: Uri, state: ProblemState): boolean {
    const key = normalizeUriKey(uri);

    if (state.severity === ProblemSeverity.None) {
      const had = this.storage.has(key);
      if (had) {
        this.storage.delete(key);
        this.folderKeys.delete(key);
        this.version++;
        if (this.batchDepth === 0) {
          this._onDidChange.fire({ kind: 'removed', uri });
        }
      }
      return had;
    }

    const old = this.storage.get(key);
    const existed = this.storage.has(key);
    this.storage.set(key, state);
    this.folderKeys.add(key);
    this.version++;
    if (this.batchDepth === 0) {
      this._onDidChange.fire(existed ? { kind: 'updated', uri } : { kind: 'added', uri });
    }
    return old === undefined ? true : this.hasChanged(old, state);
  }

  isFolderAggregate(uri: Uri): boolean {
    return this.folderKeys.has(normalizeUriKey(uri));
  }

  get(uri: Uri): ProblemState | undefined {
    return this.storage.get(normalizeUriKey(uri));
  }

  delete(uri: Uri): boolean {
    const key = normalizeUriKey(uri);
    const old = this.storage.get(key);
    if (!old) {
      return false;
    }

    // Update running totals only for file entries (not folder aggregates)
    if (!this.folderKeys.has(key)) {
      this._subtractFromTotals(old);
    }

    this.storage.delete(key);
    this.folderKeys.delete(key);
    this.ownerByKey.delete(key);
    this.version++;
    if (this.batchDepth === 0) {
      this._onDidChange.fire({ kind: 'removed', uri });
    }
    return true;
  }

  clear(): void {
    this.storage.clear();
    this.folderKeys.clear();
    this.ownerByKey.clear();
    this._runningTotals = this._zeroTotals();
    this.version++;
    if (this.batchDepth === 0) {
      this._onDidChange.fire({ kind: 'cleared' });
    }
  }

  has(uri: Uri): boolean {
    return this.storage.has(normalizeUriKey(uri));
  }

  size(): number {
    return this.storage.size;
  }

  deleteByPrefix(prefix: string): number {
    let count = 0;
    const prefixSlash = prefix + '/';
    const keysToDelete: string[] = [];

    for (const key of this.storage.keys()) {
      if (key === prefix || key.startsWith(prefixSlash)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      const old = this.storage.get(key);
      if (old !== undefined && !this.folderKeys.has(key)) {
        this._subtractFromTotals(old);
      }
      this.storage.delete(key);
      this.folderKeys.delete(key);
      this.ownerByKey.delete(key);
      count++;
    }

    if (count > 0) {
      this.version++;
      if (this.batchDepth === 0) {
        this._onDidChange.fire({ kind: 'prefixDeleted', prefix });
      }
    }

    return count;
  }

  movePrefix(oldPrefix: string, newPrefix: string): number {
    if (oldPrefix === newPrefix) return 0;
    let count = 0;
    const oldPrefixSlash = oldPrefix + '/';
    const entriesToMove: { key: string; state: ProblemState; isFolder: boolean }[] = [];

    for (const [key, state] of this.storage) {
      if (key === oldPrefix || key.startsWith(oldPrefixSlash)) {
        entriesToMove.push({ key, state, isFolder: this.folderKeys.has(key) });
      }
    }

    for (const entry of entriesToMove) {
      const newKey = newPrefix + entry.key.slice(oldPrefix.length);
      this.storage.delete(entry.key);
      this.folderKeys.delete(entry.key);
      this.storage.set(newKey, entry.state);
      if (entry.isFolder) {
        this.folderKeys.add(newKey);
      }
      const owner = this.ownerByKey.get(entry.key);
      if (owner !== undefined) {
        this.ownerByKey.delete(entry.key);
        this.ownerByKey.set(newKey, owner);
      }
      count++;
    }

    // Running totals don't change during prefix move (same states, new keys)
    if (count > 0) {
      this.version++;
      if (this.batchDepth === 0) {
        this._onDidChange.fire({ kind: 'prefixMoved', oldPrefix, newPrefix });
      }
    }

    return count;
  }

  /**
   * O(1) — returns running totals maintained on every mutation.
   * Folder aggregates are excluded (they are derived from file entries).
   */
  computeTotals(): ProblemState {
    return this._runningTotals;
  }

  configureProvider(providerName: string, priority: number): void {
    this.providerPriorities.set(providerName, priority);
  }

  unconfigureProvider(providerName: string): void {
    this.providerPriorities.delete(providerName);
  }

  releaseOwnership(providerName: string): void {
    const keysToRelease: string[] = [];
    for (const [key, owner] of this.ownerByKey) {
      if (owner === providerName) {
        keysToRelease.push(key);
      }
    }
    for (const key of keysToRelease) {
      this.ownerByKey.delete(key);
    }
  }

  getOwningProvider(uri: Uri): string | undefined {
    return this.ownerByKey.get(normalizeUriKey(uri));
  }

  getProviderPriority(providerName: string): number {
    return this.providerPriorities.get(providerName) ?? -1;
  }

  /** Iterate over file entries (non-folder-aggregate) without snapshot copy. */
  forEachFileEntry(callback: (key: string, state: ProblemState) => void): void {
    for (const [key, state] of this.storage) {
      if (!this.folderKeys.has(key)) {
        callback(key, state);
      }
    }
  }

  /** Iterate over all entries (files + folder aggregates) without snapshot copy. */
  forEachEntry(callback: (key: string, state: ProblemState, isFolder: boolean) => void): void {
    for (const [key, state] of this.storage) {
      callback(key, state, this.folderKeys.has(key));
    }
  }

  dispose(): void {
    this.storage.clear();
    this.folderKeys.clear();
    this.ownerByKey.clear();
    this.providerPriorities.clear();
    this._runningTotals = this._zeroTotals();
    this._onDidChange.dispose();
  }

  snapshot(): { readonly [key: string]: Readonly<ProblemState> } {
    const copy: Record<string, ProblemState> = {};
    for (const [key, value] of this.storage) {
      copy[key] = Object.freeze({ ...value });
    }
    return Object.freeze(copy);
  }

  private _zeroTotals(): ProblemState {
    return { severity: ProblemSeverity.None, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0 };
  }

  private _addToTotals(state: ProblemState): void {
    const t = this._runningTotals as { -readonly [K in keyof ProblemState]: ProblemState[K] };
    t.errorCount += state.errorCount;
    t.warningCount += state.warningCount;
    t.infoCount += state.infoCount;
    t.fileCount += state.fileCount;
    if (state.severity > t.severity) {
      t.severity = state.severity;
    }
  }

  private _subtractFromTotals(state: ProblemState): void {
    const t = this._runningTotals as { -readonly [K in keyof ProblemState]: ProblemState[K] };
    t.errorCount -= state.errorCount;
    t.warningCount -= state.warningCount;
    t.infoCount -= state.infoCount;
    t.fileCount -= state.fileCount;
  }

  private hasChanged(a: ProblemState, b: ProblemState): boolean {
    return (
      a.severity !== b.severity ||
      a.errorCount !== b.errorCount ||
      a.warningCount !== b.warningCount ||
      a.infoCount !== b.infoCount ||
      a.fileCount !== b.fileCount
    );
  }
}
