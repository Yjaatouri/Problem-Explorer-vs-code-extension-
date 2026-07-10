import * as assert from 'assert';
import { ColorProvider } from '../../decoration/colorProvider';
import { COLORS } from '../../core/constants';
import { ProblemSeverity } from '../../core/types';

suite('ColorProvider', () => {
  let provider: ColorProvider;

  setup(() => {
    provider = new ColorProvider();
  });

  test('getErrorColor returns ThemeColor with errorForeground id', () => {
    const color = provider.getErrorColor();
    assert.strictEqual(color.id, COLORS.ERROR_FOREGROUND);
  });

  test('getWarningColor returns ThemeColor with warningForeground id', () => {
    const color = provider.getWarningColor();
    assert.strictEqual(color.id, COLORS.WARNING_FOREGROUND);
  });

  test('getInfoColor returns ThemeColor with infoForeground id', () => {
    const color = provider.getInfoColor();
    assert.strictEqual(color.id, COLORS.INFO_FOREGROUND);
  });

  test('getColor maps Error severity to error foreground', () => {
    const color = provider.getColor(ProblemSeverity.Error);
    assert.strictEqual(color.id, COLORS.ERROR_FOREGROUND);
  });

  test('getColor maps Warning severity to warning foreground', () => {
    const color = provider.getColor(ProblemSeverity.Warning);
    assert.strictEqual(color.id, COLORS.WARNING_FOREGROUND);
  });

  test('getColor maps Info severity to info foreground', () => {
    const color = provider.getColor(ProblemSeverity.Info);
    assert.strictEqual(color.id, COLORS.INFO_FOREGROUND);
  });

  test('getColor maps None severity to info foreground (fallback)', () => {
    const color = provider.getColor(ProblemSeverity.None);
    assert.strictEqual(color.id, COLORS.INFO_FOREGROUND);
  });
});
