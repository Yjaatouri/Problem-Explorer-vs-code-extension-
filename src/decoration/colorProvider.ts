import { ThemeColor } from 'vscode';
import { ProblemSeverity } from '../core/types';
import { COLORS } from '../core/constants';

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
