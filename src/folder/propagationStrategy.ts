import { ProblemSeverity, ProblemState } from '../core/types';

/** Combine multiple child statuses into a single parent status using worst-severity-wins */
export function aggregateStatuses(children: ProblemState[]): ProblemState {
  let severity = ProblemSeverity.None;
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let fileCount = 0;

  for (let i = 0; i < children.length; i++) {
    const s = children[i];
    if (s.severity > severity) {
      severity = s.severity;
    }
    errorCount += s.errorCount;
    warningCount += s.warningCount;
    infoCount += s.infoCount;
    fileCount += s.fileCount;
  }

  return { severity, errorCount, warningCount, infoCount, fileCount };
}
