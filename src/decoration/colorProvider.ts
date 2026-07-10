import { ThemeColor } from 'vscode';
import { ProblemSeverity } from '../core/types';
import { COLORS } from '../core/constants';

/** Resolves `ProblemSeverity` to the configured `ThemeColor` */
export class ColorProvider {
  getErrorColor(): ThemeColor {
    return new ThemeColor(COLORS.ERROR_FOREGROUND);
  }

  getWarningColor(): ThemeColor {
    return new ThemeColor(COLORS.WARNING_FOREGROUND);
  }

  getInfoColor(): ThemeColor {
    return new ThemeColor(COLORS.INFO_FOREGROUND);
  }

  /** Return the `ThemeColor` matching a severity level */
  getColor(severity: ProblemSeverity): ThemeColor {
    switch (severity) {
      case ProblemSeverity.Error:
        return this.getErrorColor();
      case ProblemSeverity.Warning:
        return this.getWarningColor();
      case ProblemSeverity.Info:
        return this.getInfoColor();
      default:
        return this.getInfoColor();
    }
  }
}
