import { ProblemSeverity, SeverityCounts } from '../core/types';
import { BADGE_DOT } from '../core/constants';

/** Supported badge display styles */
export type BadgeStyle = 'letter' | 'count' | 'dot' | 'none';

const LETTERS: Record<ProblemSeverity, string> = {
  [ProblemSeverity.None]: '',
  [ProblemSeverity.Info]: '!',
  [ProblemSeverity.Warning]: 'W',
  [ProblemSeverity.Error]: 'E',
};

/** Produce the badge string for a given severity, counts, and style */
export function getBadge(
  severity: ProblemSeverity,
  counts: SeverityCounts,
  style: BadgeStyle,
): string {
  if (severity === ProblemSeverity.None) {
    return '';
  }

  switch (style) {
    case 'none':
      return '';
    case 'dot':
      return BADGE_DOT;
    case 'letter':
      return LETTERS[severity];
    case 'count':
      return String(
        severity === ProblemSeverity.Error
          ? counts.errorCount
          : severity === ProblemSeverity.Warning
            ? counts.warningCount
            : counts.infoCount,
      );
    default:
      return '';
  }
}
