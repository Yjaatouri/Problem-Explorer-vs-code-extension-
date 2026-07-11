import {
  CancellationToken,
  Event,
  EventEmitter,
  FileDecoration,
  FileDecorationProvider,
  languages,
  ThemeColor,
  Uri,
  WorkspaceFolder,
  workspace,
} from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { Config, ProblemSeverity, ProblemStatus } from '../core/types';
import { COLORS, BADGE_LETTERS } from '../core/constants';
import { getBadge } from './badgeFormatter';
import { toProblemStatus, applySeverityOverrides } from '../diagnostics/severityMapper';
import { isIgnored } from '../performance/ignoreFilter';

export interface WorkspaceFolderDelegate {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
}

const defaultDelegate: WorkspaceFolderDelegate = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
};

export class DecorationEngine implements FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new EventEmitter<Uri | Uri[] | undefined>();
  readonly onDidChangeFileDecorations: Event<Uri | Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;
  private readonly wf: WorkspaceFolderDelegate;
  private severityOverrides: Record<string, Record<string, string>> | undefined;
  private config: Config | undefined;

  constructor(
    private readonly cache: ProblemCache,
    wf?: WorkspaceFolderDelegate,
  ) {
    this.wf = wf ?? defaultDelegate;
  }

  setSeverityOverrides(overrides: Record<string, Record<string, string>> | undefined): void {
    this.severityOverrides = overrides;
  }

  /** Provide the current user configuration. When unset, defaults apply (enabled, letter badges). */
  setConfig(config: Config | undefined): void {
    this.config = config;
  }

  provideFileDecoration(
    uri: Uri,
    _token: CancellationToken,
  ): FileDecoration | undefined {
    try {
      if (this.config && !this.config.enabled) {
        return undefined;
      }

      const folder = this.wf.getWorkspaceFolder(uri);
      if (!folder) {
        return undefined;
      }

      let status = this.cache.get(uri, folder.uri);

      if (!status) {
        // Don't fetch diagnostics for ignored files
        if (isIgnored(uri, this.config?.ignorePatterns)) {
          return undefined;
        }
        const diagnostics = languages.getDiagnostics(uri);
        if (diagnostics.length > 0) {
          const mapped = applySeverityOverrides(uri, diagnostics, this.severityOverrides);
          status = toProblemStatus(mapped);
          this.cache.set(uri, status, folder.uri);
        }
      }

      if (!status || status.severity === ProblemSeverity.None) {
        return undefined;
      }

      if (
        this.config &&
        !this.config.showWarnings &&
        status.severity !== ProblemSeverity.Error
      ) {
        return undefined;
      }

      return this.toDecoration(status);
    } catch {
      return undefined;
    }
  }

  fireDidChange(uris: Uri | Uri[] | undefined): void {
    this._onDidChangeFileDecorations.fire(uris);
  }

  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  private toDecoration(status: ProblemStatus): FileDecoration | undefined {
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
        return undefined;
    }

    const style = this.config?.badgeStyle ?? 'letter';
    if (style !== 'letter') {
      badge = getBadge(status.severity, status, style);
    }
    // FileDecoration.badge is limited to 2 characters by the VS Code API
    if (badge.length > 2) {
      badge = '9+';
    }

    const tooltip = this.formatTooltip(status);

    return {
      badge: badge.length > 0 ? badge : undefined,
      color,
      tooltip,
      propagate: false,
    };
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
    if (parts.length > 0 && status.fileCount > 1) {
      parts.push(`across ${status.fileCount} file${status.fileCount !== 1 ? 's' : ''}`);
    }
    return parts.join(', ');
  }
}
