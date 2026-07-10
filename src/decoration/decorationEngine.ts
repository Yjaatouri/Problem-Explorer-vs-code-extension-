import {
  CancellationToken,
  Event,
  EventEmitter,
  FileDecoration,
  FileDecorationProvider,
  languages,
  ThemeColor,
  Uri,
  workspace,
} from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { ProblemSeverity, ProblemStatus } from '../core/types';
import { COLORS, BADGE_LETTERS } from '../core/constants';
import { toProblemStatus } from '../diagnostics/severityMapper';

export class DecorationEngine implements FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new EventEmitter<Uri | Uri[] | undefined>();
  readonly onDidChangeFileDecorations: Event<Uri | Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;

  constructor(private readonly cache: ProblemCache) {}

  provideFileDecoration(
    uri: Uri,
    _token: CancellationToken,
  ): FileDecoration | undefined {
    const folder = workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }

    let status = this.cache.get(uri, folder.uri);

    if (!status) {
      const diagnostics = languages.getDiagnostics(uri);
      if (diagnostics.length > 0) {
        status = toProblemStatus(diagnostics);
        this.cache.set(uri, status, folder.uri);
      }
    }

    if (!status || status.severity === ProblemSeverity.None) {
      return undefined;
    }

    return this.toDecoration(status);
  }

  fireDidChange(uris: Uri | Uri[] | undefined): void {
    this._onDidChangeFileDecorations.fire(uris);
  }

  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  private toDecoration(status: ProblemStatus): FileDecoration {
    let color: ThemeColor;
    let badge: string;

    switch (status.severity) {
      case ProblemSeverity.Error:
        color = new ThemeColor(COLORS.ERROR_FOREGROUND);
        badge = BADGE_LETTERS.error;
        break;
      case ProblemSeverity.Warning:
        color = new ThemeColor(COLORS.WARNING_FOREGROUND);
        badge = BADGE_LETTERS.warning;
        break;
      case ProblemSeverity.Info:
        color = new ThemeColor(COLORS.INFO_FOREGROUND);
        badge = BADGE_LETTERS.info;
        break;
      default:
        return undefined as unknown as FileDecoration;
    }

    const tooltip = this.formatTooltip(status);

    return { badge, color, tooltip, propagate: false };
  }

  private formatTooltip(status: ProblemStatus): string {
    const parts: string[] = [];
    if (status.errorCount > 0) {
      parts.push(`${status.errorCount} error${status.errorCount !== 1 ? 's' : ''}`);
    }
    if (status.warningCount > 0) {
      parts.push(`${status.warningCount} warning${status.warningCount !== 1 ? 's' : ''}`);
    }
    if (status.infoCount > 0) {
      parts.push(`${status.infoCount} info${status.infoCount !== 1 ? 's' : ''}`);
    }
    return parts.join(', ');
  }
}
