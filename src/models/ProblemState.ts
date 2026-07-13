import { ProblemSeverity } from './ProblemSeverity';
import { ProblemSource } from './ProblemSource';

/** Immutable snapshot of all problems for a single file or folder URI. */
export interface ProblemState {
  /** Stable string key for the URI (used as Map key by the store). */
  readonly uri: string;
  /** Workspace folder URI key this state belongs to. */
  readonly folderKey: string;
  /** Worst severity among all problems for this URI. */
  readonly severity: ProblemSeverity;
  /** Number of error-severity problems. */
  readonly errorCount: number;
  /** Number of warning-severity problems. */
  readonly warningCount: number;
  /** Number of information-severity problems. */
  readonly infoCount: number;
  /** Number of files contributing to this state (1 for a file, aggregated for folders). */
  readonly fileCount: number;
  /** Origin of the diagnostics that produced this state. */
  readonly source: ProblemSource;
  /** Epoch timestamp (ms) when this state was last updated. */
  readonly updatedAt: number;
}
