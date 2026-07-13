import { Uri } from 'vscode';
import { ProblemState } from '../models/ProblemState';
import { normalizeUriKey } from '../core/uriKey';

/** Central in-memory database for all project problems. */
export class ProblemStore {
  private readonly storage = new Map<string, ProblemState>();

  constructor() {}

  set(uri: Uri, state: ProblemState): void {
    this.storage.set(normalizeUriKey(uri), state);
  }

  get(uri: Uri): ProblemState | undefined {
    return this.storage.get(normalizeUriKey(uri));
  }

  delete(uri: Uri): boolean {
    return this.storage.delete(normalizeUriKey(uri));
  }

  clear(): void {
    this.storage.clear();
  }

  has(uri: Uri): boolean {
    return this.storage.has(normalizeUriKey(uri));
  }

  size(): number {
    return this.storage.size;
  }

  dispose(): void {
    this.storage.clear();
  }
}