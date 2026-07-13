import { Event, EventEmitter, Uri } from 'vscode';
import { ProblemState } from '../models/ProblemState';
import { ProblemStoreChange } from '../models/ProblemStoreChange';
import { normalizeUriKey } from '../core/uriKey';

/** Central in-memory database for all project problems. */
export class ProblemStore {
  private readonly storage = new Map<string, ProblemState>();
  private readonly _onDidChange = new EventEmitter<ProblemStoreChange>();

  readonly onDidChange: Event<ProblemStoreChange> = this._onDidChange.event;

  constructor() {}

  set(uri: Uri, state: ProblemState): void {
    const key = normalizeUriKey(uri);
    const existed = this.storage.has(key);
    this.storage.set(key, state);
    this._onDidChange.fire(existed ? { kind: 'updated', uri } : { kind: 'added', uri });
  }

  get(uri: Uri): ProblemState | undefined {
    return this.storage.get(normalizeUriKey(uri));
  }

  delete(uri: Uri): boolean {
    const key = normalizeUriKey(uri);
    if (!this.storage.has(key)) {
      return false;
    }
    this.storage.delete(key);
    this._onDidChange.fire({ kind: 'removed', uri });
    return true;
  }

  clear(): void {
    this.storage.clear();
    this._onDidChange.fire({ kind: 'cleared' });
  }

  has(uri: Uri): boolean {
    return this.storage.has(normalizeUriKey(uri));
  }

  size(): number {
    return this.storage.size;
  }

  dispose(): void {
    this.storage.clear();
    this._onDidChange.dispose();
  }
}