import { ProblemSeverity, SeverityCounts } from '../core/types';
import { BADGE_DOT } from '../core/constants';

/** Supported badge display styles */
export type BadgeStyle = 'letter' | 'count' | 'dot' | 'none';

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
