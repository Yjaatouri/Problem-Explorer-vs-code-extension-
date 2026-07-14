import { Event, Uri } from 'vscode';
import { ProblemState } from '../core/types';
import { ProblemStoreChange } from '../models/ProblemStoreChange';

export interface IProblemProvider {
  getState(uri: Uri, folderUri: Uri): ProblemState | undefined;
  getAllInFolder(folderUri: Uri): ReadonlyMap<string, ProblemState>;
  computeTotals(): ProblemState;
  snapshot(): Readonly<Record<string, Readonly<ProblemState>>>;
  readonly onDidChange: Event<ProblemStoreChange>;
}
