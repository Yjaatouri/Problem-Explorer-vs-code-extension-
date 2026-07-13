import { Event, EventEmitter, Uri } from 'vscode';
import { ProblemStoreChange } from '../models/ProblemStoreChange';
import { ProblemState } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';

/**
 * Synchronous in-memory database for all project diagnostics.
 *
 * ## Responsibilities
 * - Stores one `ProblemState` per unique URI via `normalizeUriKey`.
 * - Provides CRUD operations (`set`/`get`/`delete`/`clear`/`has`/`size`).
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
   * Insert or update state for a URI.
   * Fires `added` or `updated` event (unless inside a batch).
   * Increments the version counter.
   */
  set(uri: Uri, state: ProblemState): void {
    const key = normalizeUriKey(uri);
    const existed = this.storage.has(key);
    this.storage.set(key, state);
    this.version++;
    if (this.batchDepth === 0) {
      this._onDidChange.fire(existed ? { kind: 'updated', uri } : { kind: 'added', uri });
    }
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
   * Clear all state, dispose the event emitter. No mutations allowed after this.
   */
  dispose(): void {
    this.storage.clear();
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
}