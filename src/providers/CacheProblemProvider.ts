import { Event, EventEmitter, Uri } from 'vscode';
import { ProblemState } from '../core/types';
import { ProblemCache } from '../cache/cacheLayer';
import { IProblemProvider } from './IProblemProvider';
import { ProblemStoreChange } from '../models/ProblemStoreChange';

export class CacheProblemProvider implements IProblemProvider {
  private readonly _onDidChange = new EventEmitter<ProblemStoreChange>();

  readonly onDidChange: Event<ProblemStoreChange> = this._onDidChange.event;

  constructor(private readonly cache: ProblemCache) {}

  getState(uri: Uri, folderUri: Uri): ProblemState | undefined {
    return this.cache.get(uri, folderUri);
  }

  getAllInFolder(folderUri: Uri): ReadonlyMap<string, ProblemState> {
    return new Map(this.cache.getRawEntries(folderUri));
  }

  computeTotals(): ProblemState {
    return this.cache.computeTotals();
  }

  snapshot(): Record<string, ProblemState> {
    return {};
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
