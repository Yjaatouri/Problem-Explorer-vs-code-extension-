import * as assert from 'assert';
import { ProblemSeverity } from '../../core/types';
import { getBadge, BadgeStyle } from '../../decoration/badgeFormatter';
import { BADGE_DOT } from '../../core/constants';

suite('BadgeFormatter', () => {
  const counts = { errorCount: 0, warningCount: 0, infoCount: 0 };

  suite('letter style', () => {
    const style: BadgeStyle = 'letter';

    test('error returns E', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Error, { ...counts, errorCount: 3 }, style), 'E');
    });

    test('warning returns W', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Warning, { ...counts, warningCount: 2 }, style), 'W');
    });

    test('info returns !', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Info, { ...counts, infoCount: 1 }, style), '!');
    });

    test('none returns empty string', () => {
      assert.strictEqual(getBadge(ProblemSeverity.None, counts, style), '');
    });
  });

  suite('count style', () => {
    const style: BadgeStyle = 'count';

    test('error returns error count', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Error, { ...counts, errorCount: 3 }, style), '3');
    });

    test('warning returns warning count', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Warning, { ...counts, warningCount: 5 }, style), '5');
    });

    test('info returns info count', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Info, { ...counts, infoCount: 2 }, style), '2');
    });

    test('none returns empty string', () => {
      assert.strictEqual(getBadge(ProblemSeverity.None, counts, style), '');
    });

    test('large counts are formatted as numbers', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Error, { ...counts, errorCount: 999 }, style), '999');
    });
  });

  suite('dot style', () => {
    const style: BadgeStyle = 'dot';

    test('error shows dot', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Error, { ...counts, errorCount: 1 }, style), BADGE_DOT);
    });

    test('warning shows dot', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Warning, { ...counts, warningCount: 1 }, style), BADGE_DOT);
    });

    test('info shows dot', () => {
      assert.strictEqual(getBadge(ProblemSeverity.Info, { ...counts, infoCount: 1 }, style), BADGE_DOT);
    });

    test('none returns empty string', () => {
      assert.strictEqual(getBadge(ProblemSeverity.None, counts, style), '');
    });
  });

  suite('none style', () => {
    [ProblemSeverity.Error, ProblemSeverity.Warning, ProblemSeverity.Info, ProblemSeverity.None].forEach((s) => {
      test(`${ProblemSeverity[s]} returns empty string`, () => {
        assert.strictEqual(getBadge(s, counts, 'none'), '');
      });
    });
  });
});
