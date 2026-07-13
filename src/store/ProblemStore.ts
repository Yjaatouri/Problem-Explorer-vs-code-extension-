import { Event, EventEmitter, Uri } from 'vscode';
import { ProblemState } from '../models/ProblemState';
import { normalizeUriKey } from '../core/uriKey';

/** Central in-memory database for all project problems. */
export class ProblemStore {
  private readonly storage = new Map<string, ProblemState>();
  private readonly _onDidChange = new EventEmitter<Uri | undefined>();

  readonly onDidChange: Event<Uri | undefined> = this._onDidChange.event;

  constructor() {}

  set(uri: Uri, state: ProblemState): void {
    this.storage.set(normalizeUriKey(uri), state);
    this._onDidChange.fire(uri);
  }

  get(uri: Uri): ProblemState | undefined {
    return this.storage.get(normalizeUriKey(uri));
  }

  delete(uri: Uri): boolean {
    const removed = this.storage.delete(normalizeUriKey(uri));
    if (removed) {
      this._onDidChange.fire(uri);
    }
    return removed;
  }

  clear(): void {
    this.storage.clear();
    this._onDidChange.fire(undefined);
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