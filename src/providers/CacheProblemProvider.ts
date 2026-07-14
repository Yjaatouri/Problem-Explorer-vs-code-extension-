import { Uri } from 'vscode';
import { ProblemState } from '../core/types';
import { ProblemCache } from '../cache/cacheLayer';
import { BaseProblemProvider } from './BaseProblemProvider';

export class CacheProblemProvider extends BaseProblemProvider {
  constructor(private readonly cache: ProblemCache) {
    super();
  }

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
}
