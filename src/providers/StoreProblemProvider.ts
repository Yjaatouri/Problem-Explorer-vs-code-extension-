import { Event, Uri } from 'vscode';
import { ProblemSeverity, ProblemState } from '../core/types';
import { ProblemStore } from '../store/ProblemStore';
import { IProblemProvider } from './IProblemProvider';
import { ProblemStoreChange } from '../models/ProblemStoreChange';

export class StoreProblemProvider implements IProblemProvider {
  readonly onDidChange: Event<ProblemStoreChange>;

  constructor(private readonly store: ProblemStore) {
    this.onDidChange = store.onDidChange;
  }

  getState(uri: Uri, _folderUri: Uri): ProblemState | undefined {
    return this.store.get(uri);
  }

  getAllInFolder(_folderUri: Uri): ReadonlyMap<string, ProblemState> {
    return new Map(Object.entries(this.store.snapshot()));
  }

  computeTotals(): ProblemState {
    const snap = this.store.snapshot();
    const values = Object.values(snap);
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    let fileCount = 0;
    let maxSeverity = ProblemSeverity.None;
    for (const s of values) {
      if (s.severity > maxSeverity) maxSeverity = s.severity;
      errorCount += s.errorCount;
      warningCount += s.warningCount;
      infoCount += s.infoCount;
      fileCount += s.fileCount;
    }
    return { severity: maxSeverity, errorCount, warningCount, infoCount, fileCount };
  }

  snapshot(): Record<string, ProblemState> {
    return { ...this.store.snapshot() } as Record<string, ProblemState>;
  }
}
