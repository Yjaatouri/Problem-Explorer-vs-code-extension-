import { ProblemSeverity } from '@pe/core';

import type { ProblemSummary } from '@pe/api';

import { BADGE_DOT } from './constants.js';

export type BadgeStyle = 'letter' | 'count' | 'dot' | 'none';

const LETTERS: Record<ProblemSeverity, string> = {
  [ProblemSeverity.None]: '',
  [ProblemSeverity.Info]: '!',
  [ProblemSeverity.Warning]: 'W',
  [ProblemSeverity.Error]: 'E',
};

export function getBadge(
  severity: ProblemSeverity,
  summary: Pick<ProblemSummary, 'errorCount' | 'warningCount' | 'infoCount'>,
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
      return LETTERS[severity] ?? '';
    case 'count':
      return String(
        severity === ProblemSeverity.Error
          ? summary.errorCount
          : severity === ProblemSeverity.Warning
            ? summary.warningCount
            : summary.infoCount,
      );
    default:
      return '';
  }
}