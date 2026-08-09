import { describe, expect, it } from 'vitest';

import { ProblemSeverity } from '@pe/core';

import { getBadge } from '../src/badge.js';

const counts = { errorCount: 3, warningCount: 2, infoCount: 1 };

describe('getBadge', () => {
  it('returns empty for None severity', () => {
    expect(getBadge(ProblemSeverity.None, counts, 'letter')).toBe('');
  });

  it('letter style: E/W/!', () => {
    expect(getBadge(ProblemSeverity.Error, counts, 'letter')).toBe('E');
    expect(getBadge(ProblemSeverity.Warning, counts, 'letter')).toBe('W');
    expect(getBadge(ProblemSeverity.Info, counts, 'letter')).toBe('!');
  });

  it('count style: uses the count of the worst severity', () => {
    expect(getBadge(ProblemSeverity.Error, counts, 'count')).toBe('3');
    expect(getBadge(ProblemSeverity.Warning, counts, 'count')).toBe('2');
    expect(getBadge(ProblemSeverity.Info, counts, 'count')).toBe('1');
  });

  it('dot style: single dot', () => {
    expect(getBadge(ProblemSeverity.Error, counts, 'dot')).toBe('\u25CF');
  });

  it('none style: empty', () => {
    expect(getBadge(ProblemSeverity.Error, counts, 'none')).toBe('');
  });
});