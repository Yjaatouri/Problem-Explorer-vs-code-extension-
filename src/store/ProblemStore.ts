import { Event, EventEmitter, Uri } from 'vscode';
import { ProblemStoreChange } from '../models/ProblemStoreChange';
import { ProblemState, ProblemSeverity } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';

/**
 * Synchronous in-memory database for all project diagnostics.
 *
 * ## Responsibilities
 * - Stores one `ProblemState` per unique URI via `normalizeUriKey`.
 * - Tracks folder-aggregate entries separately from file entries so
 *   `computeTotals()` can sum file entries only (folder aggregates are
 *   derived from files and would double-count).
 * - Provides CRUD operations (`set`/`get`/`delete`/`clear`/`has`/`size`).
 * - Provides folder-aggregate operations (`setFolderAggregate`/`isFolderAggregate`).
 * - Provides aggregate totals via `computeTotals()`.
 * - Emits typed change events so consumers (UI providers, API layer) stay in sync.
 * - Supports batch mutations that coalesce into a single `{ kind: 'batch' }` event.
 * - Maintains a monotonically increasing version counter (`getVersion`)
 *   for cache-invalidation use by providers and renderers.
 * - Produces frozen snapshots for read-only external access.
 *
 * ## Lifetime
 * - Created once during extension activation (`extension.ts`).
 * - Owned by the extension's service graph; injected into managers and providers.
 * - `dispose()` clears all state and unregisters the event emitter.
 * - Never re-activated after disposal.
 *
 * ## Thread model
 * - All operations run on the VS Code extension host's single JS thread.
 * - No locks or atomics needed — events are fired synchronously on the same call stack.
 *
 * ## Event flow
 *   set/delete/clear → version++ → batchDepth check → EventEmitter.fire
 *                         ↓
 *   onDidChange listeners (synchronous, same tick)
 *
 * - Individual mutations fire immediately unless inside `beginBatch()…endBatch()`.
 * - Nested batches are supported via a depth counter; only the outermost `endBatch()` fires.
 * - Listeners receive a discriminated union (`ProblemStoreChange`) to react by kind.
 *
 * ## Ownership
 * - The store owns its `Map<string, ProblemState>` — no external references to the map.
 * - States passed to `set()` are stored **by reference** (not cloned); callers must not
 *   mutate them after insertion.
 * - `snapshot()` returns deep-frozen copies to safely expose data to external code.
 *
 * ## Future providers
 * - The store is provider-agnostic — it does not depend on `DiagnosticCollection`,
 *   `FileDecorationProvider`, or any rendering layer.
 * - Providers should subscribe to `onDidChange` and call `snapshot()` / `getVersion()`
 *   to react to state changes.
 * - Batch support allows providers to defer expensive recomputation (e.g. decoration
 *   recalculation) until after a set of related mutations.
 */
export class ProblemStore {
  private readonly storage = new Map<string, ProblemState>();
  private readonly folderKeys = new Set<string>();
  private readonly ownerByKey = new Map<string, string>();
  private readonly providerPriorities = new Map<string, number>();
  private readonly _onDidChange = new EventEmitter<ProblemStoreChange>();
  private batchDepth = 0;
  private version = 0;

  readonly onDidChange: Event<ProblemStoreChange> = this._onDidChange.event;

  constructor() {}

  /**
   * Monotonically increasing version, incremented on every mutation.
   * Useful for cache invalidation in providers and renderers.
   */
  getVersion(): number {
    return this.version;
  }

  /** Start a batch. Nested calls are supported. */
  beginBatch(): void {
    this.batchDepth++;
  }

  /**
   * End a batch. Fires a single `{ kind: 'batch' }` event when the outermost
   * batch completes. No-op if no batch is active.
   */
  endBatch(): void {
    if (this.batchDepth === 0) return;
    this.batchDepth--;
    if (this.batchDepth === 0) {
      this._onDidChange.fire({ kind: 'batch' });
    }
  }

  /**
   * Insert or update state for a URI (file entry).
   * Clears any stale folder-aggregate marker for this key.
   * Fires `added` or `updated` event (unless inside a batch or state unchanged).
   * Increments the version counter.
   *
   * **Ownership**: If `providerName` is given, the store enforces priority-based
   * ownership. When a key is already owned by a higher-priority provider, the
   * write is rejected. Same-priority or unowned keys are accepted. Ownership
   * is transferred to the writing provider on successful write.
   *
   * @returns `true` if the value changed or was newly inserted.
   */
  set(uri: Uri, state: ProblemState, providerName?: string): boolean {
    const key = normalizeUriKey(uri);
    if (providerName !== undefined) {
      const currentOwner = this.ownerByKey.get(key);
      if (currentOwner !== undefined) {
        const currentPriority = this.providerPriorities.get(currentOwner) ?? -1;
        const newPriority = this.providerPriorities.get(providerName) ?? -1;
        if (newPriority < currentPriority) {
          return false;
        }
      }
    }
    const old = this.storage.get(key);
    if (old !== undefined && !this.hasChanged(old, state)) {
      return false;
    }
    const existed = old !== undefined;
    this.storage.set(key, state);
    this.folderKeys.delete(key);
    if (providerName !== undefined) {
      this.ownerByKey.set(key, providerName);
    }
    this.version++;
    if (this.batchDepth === 0) {
      this._onDidChange.fire(existed ? { kind: 'updated', uri } : { kind: 'added', uri });
    }
    return true;
  }

  /**
   * Insert or update a folder-aggregate state for a URI.
   * Marks the key as a folder aggregate so `computeTotals()` can skip it
   * (folder aggregates are derived from file entries; summing them would
   * double-count).
   *
   * A `None`-severity aggregate is deleted instead (no entry when the
    * folder has no problems).
   * @returns `true` if the value changed, was newly inserted, or was deleted.
   */
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

  /**
   * Check whether a URI is a folder-aggregate entry.
   */
  isFolderAggregate(uri: Uri): boolean {
    return this.folderKeys.has(normalizeUriKey(uri));
  }

  /**
   * Retrieve state for a URI, or `undefined` if not present.
   */
  get(uri: Uri): ProblemState | undefined {
    return this.storage.get(normalizeUriKey(uri));
  }

  /**
   * Remove state for a URI. Returns `true` if the entry existed.
   * Fires a `removed` event (unless inside a batch).
   * Increments the version counter.
   */
  delete(uri: Uri): boolean {
    const key = normalizeUriKey(uri);
    if (!this.storage.has(key)) {
      return false;
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

  /**
   * Remove all state. Fires a `cleared` event (unless inside a batch).
   * Increments the version counter.
   */
  clear(): void {
    this.storage.clear();
    this.folderKeys.clear();
    this.ownerByKey.clear();
    this.version++;
    if (this.batchDepth === 0) {
      this._onDidChange.fire({ kind: 'cleared' });
    }
  }

  /**
   * Check whether a URI has state in the store.
   */
  has(uri: Uri): boolean {
    return this.storage.has(normalizeUriKey(uri));
  }

  /**
   * Number of tracked URIs.
   */
  size(): number {
    return this.storage.size;
  }

  /**
   * Delete all entries whose normalized key starts with the given prefix.
   * Fires a single `prefixDeleted` event if any entries were removed.
   * @returns number of entries deleted
   */
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

  /**
   * Re-key all entries whose normalized key starts with `oldPrefix` to `newPrefix`.
   * Fires a single `movePrefix` event if any entries were moved.
   * @returns number of entries re-keyed
   */
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

    if (count > 0) {
      this.version++;
      if (this.batchDepth === 0) {
        this._onDidChange.fire({ kind: 'prefixMoved', oldPrefix, newPrefix });
      }
    }

    return count;
  }

  /**
   * Aggregate all **file** entries (excluding folder aggregates) across the store.
   * Folder aggregates are skipped because their counts are derived from file
   * entries — summing them again would double-count.
   */
  computeTotals(): ProblemState {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    let fileCount = 0;
    let maxSeverity = ProblemSeverity.None;

    for (const [key, status] of this.storage) {
      if (this.folderKeys.has(key)) {
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

    return {
      severity: maxSeverity,
      errorCount,
      warningCount,
      infoCount,
      fileCount,
    };
  }

  /**
   * Clear all state, dispose the event emitter. No mutations allowed after this.
   */
  /**
   * Register a provider's priority for ownership resolution.
   * Higher priority wins when multiple providers write to the same URI.
   * Call once per provider before writes begin.
   */
  configureProvider(providerName: string, priority: number): void {
    this.providerPriorities.set(providerName, priority);
  }

  /**
   * Remove a provider's priority registration (called on provider stop/unregister).
   */
  unconfigureProvider(providerName: string): void {
    this.providerPriorities.delete(providerName);
  }

  /**
   * Release ownership of all keys owned by the given provider.
   * Called when a provider stops or is unregistered so its keys
   * can be claimed by other providers.
   */
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

  /**
   * Get the provider name that currently owns a URI, or undefined if unowned.
   */
  getOwningProvider(uri: Uri): string | undefined {
    return this.ownerByKey.get(normalizeUriKey(uri));
  }

  /**
   * Get the configured priority for a provider, or -1 if not registered.
   */
  getProviderPriority(providerName: string): number {
    return this.providerPriorities.get(providerName) ?? -1;
  }

  dispose(): void {
    this.storage.clear();
    this.folderKeys.clear();
    this.ownerByKey.clear();
    this.providerPriorities.clear();
    this._onDidChange.dispose();
  }

  /**
   * Return a deep-frozen snapshot of all entries keyed by `normalizeUriKey`.
   * External code cannot mutate the returned object or its values.
   * Does not reflect subsequent writes to this store.
   */
  snapshot(): { readonly [key: string]: Readonly<ProblemState> } {
    const copy: Record<string, ProblemState> = {};
    for (const [key, value] of this.storage) {
      copy[key] = Object.freeze({ ...value });
    }
    return Object.freeze(copy);
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