import {
  CancellationToken,
  Disposable,
  Event,
  EventEmitter,
  FileDecoration,
  FileDecorationProvider,
  ThemeColor,
  Uri,
  WorkspaceFolder,
  workspace,
} from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { Config, ProblemSeverity, ProblemState } from '../core/types';
import { COLORS, BADGE_LETTERS } from '../core/constants';
import { getBadge } from './badgeFormatter';
import { isIgnored } from '../performance/ignoreFilter';


export interface DecorationEngineDelegate {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
}

const defaultDecorationDelegate: DecorationEngineDelegate = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
};

export class DecorationEngine implements FileDecorationProvider, Disposable {
  private readonly _onDidChangeFileDecorations = new EventEmitter<Uri | Uri[] | undefined>();
  readonly onDidChangeFileDecorations: Event<Uri | Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;
  private config: Config | undefined;

  // Coalescing state: batch multiple fireDidChange calls into a single array fire
  private _coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private _coalescedUris = new Set<string>();

  constructor(
    private readonly problemStore: ProblemStore,
    private readonly delegate: DecorationEngineDelegate = defaultDecorationDelegate,
  ) {
  }

  setConfig(config: Config | undefined): void {
    this.config = config;
  }

  provideFileDecoration(
    uri: Uri,
    _token: CancellationToken,
  ): FileDecoration | undefined {
    const folder = this.delegate.getWorkspaceFolder(uri);
    const status = this.problemStore.get(uri);

    if (!folder) {
      return undefined;
    }

    const ignored = isIgnored(uri, this.config?.ignorePatterns);

    try {
      if (this.config && !this.config.enabled) {
        return undefined;
      }

      if (!status) {
        if (ignored) {
          return undefined;
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

      const deco = this.toDecoration(status);
      if (!deco) {
        return undefined;
      }
      return deco;
    } catch {
      return undefined;
    }
  }

  /**
   * Fire decoration change events with coalescing: multiple calls in the same
   * tick are merged into a single array fire, reducing VS Code Explorer
   * invalidation requests.
   */
  fireDidChange(uris: Uri | Uri[] | undefined): void {
    if (uris === undefined) {
      this._flushCoalesced();
      this._fire(undefined);
      return;
    }

    if (Array.isArray(uris)) {
      for (let i = 0; i < uris.length; i++) {
        this._coalescedUris.add(uris[i].toString());
      }
    } else {
      this._coalescedUris.add(uris.toString());
    }

    this._scheduleCoalescedFire();
  }

  /**
   * Deprecated: use fireDidChange with specific URIs instead.
   * Fires undefined causing full VS Code invalidation.
   */
  refresh(): void {
    this.fireDidChange(undefined);
  }

  dispose(): void {
    if (this._coalesceTimer !== undefined) {
      clearTimeout(this._coalesceTimer);
    }
    this._onDidChangeFileDecorations.dispose();
  }

  private _fire(uris: Uri | Uri[] | undefined): void {
    this._onDidChangeFileDecorations.fire(uris);
  }

  private _scheduleCoalescedFire(): void {
    if (this._coalesceTimer !== undefined) {
      return;
    }
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = undefined;
      this._flushCoalesced();
    }, 0);
  }

  private _flushCoalesced(): void {
    if (this._coalescedUris.size === 0) {
      return;
    }
    const uris = Array.from(this._coalescedUris, (s) => Uri.parse(s));
    this._coalescedUris.clear();
    this._fire(uris);
  }

  private toDecoration(status: ProblemState): FileDecoration | undefined {
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

  private formatTooltip(status: ProblemState): string {
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
