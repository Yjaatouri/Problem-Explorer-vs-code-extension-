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
import { normalizeUriKey } from '../core/uriKey';

export const forensicCounters = {
  provideFileDecorationCalls: 0,
  returnDecoration: 0,
  returnUndefined: 0,
  reasonNoWsFolder: 0,
  reasonDisabled: 0,
  reasonIgnored: 0,
  reasonNoStatus: 0,
  reasonShowWarnings: 0,
  reasonException: 0,
  fireDidChangeCalls: 0,
  fireDidChangeUndefined: 0,
  fireDidChangeArray: 0,
  fireDidChangeSingle: 0,
};

export function dumpForensicReport(): string {
  const c = forensicCounters;
  const lines = [
    `[FORENSIC:REPORT] ===== FORENSIC REPORT =====`,
    `[FORENSIC:REPORT] provideFileDecoration calls: ${c.provideFileDecorationCalls}`,
    `[FORENSIC:REPORT]   Returned decoration: ${c.returnDecoration}`,
    `[FORENSIC:REPORT]   Returned undefined: ${c.returnUndefined}`,
    `[FORENSIC:REPORT]   Reason: No workspace folder: ${c.reasonNoWsFolder}`,
    `[FORENSIC:REPORT]   Reason: Disabled: ${c.reasonDisabled}`,
    `[FORENSIC:REPORT]   Reason: Ignored: ${c.reasonIgnored}`,
    `[FORENSIC:REPORT]   Reason: No status/None severity: ${c.reasonNoStatus}`,
    `[FORENSIC:REPORT]   Reason: showWarnings=false: ${c.reasonShowWarnings}`,
    `[FORENSIC:REPORT]   Reason: Exception: ${c.reasonException}`,
    `[FORENSIC:REPORT] fireDidChange calls: ${c.fireDidChangeCalls}`,
    `[FORENSIC:REPORT]   fireDidChange(undefined): ${c.fireDidChangeUndefined}`,
    `[FORENSIC:REPORT]   fireDidChange(Array): ${c.fireDidChangeArray}`,
    `[FORENSIC:REPORT]   fireDidChange(single): ${c.fireDidChangeSingle}`,
    `[FORENSIC:REPORT] ===== END FORENSIC REPORT =====`,
  ];
  return lines.join('\n');
}

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
  private readonly _log: (msg: string) => void;

  // Coalescing state: batch multiple fireDidChange calls into a single array fire
  private _coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private _coalescedUris = new Set<string>();

  constructor(
    private readonly problemStore: ProblemStore,
    private readonly delegate: DecorationEngineDelegate = defaultDecorationDelegate,
    log?: (msg: string) => void,
  ) {
    this._log = log ?? (() => { /* no-op */ });
  }

  setConfig(config: Config | undefined): void {
    this.config = config;
  }

  provideFileDecoration(
    uri: Uri,
    _token: CancellationToken,
  ): FileDecoration | undefined {
    forensicCounters.provideFileDecorationCalls++;
    const callNum = forensicCounters.provideFileDecorationCalls;
    const now = new Date().toISOString();
    const fsPath = uri.fsPath;
    const configEnabled = this.config?.enabled ?? true;
    const folder = this.delegate.getWorkspaceFolder(uri);

    const explorerUriStr = uri.toString(true);

    if (!folder) {
      forensicCounters.returnUndefined++;
      forensicCounters.reasonNoWsFolder++;
      this._log(`[FORENSIC:Step5] provideFileDecoration #${callNum} URI=${explorerUriStr} time=${now}`);
      this._log('  -> RETURN: no workspace folder');
      return undefined;
    }

    const ignored = isIgnored(uri, this.config?.ignorePatterns);
    const status = this.problemStore.get(uri);
    const uriKey = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folder.uri);

    this._log(`[FORENSIC:Step8] URI consistency: explorerUri=${uri.toString(true)} fsPath=${fsPath} uriKey=${uriKey} folderKey=${folderKey} scheme=${uri.scheme} authority=${uri.authority}`);

    this._log(`[FORENSIC:Step5] provideFileDecoration #${callNum} URI=${explorerUriStr} time=${now} enabled=${configEnabled} wsFolder=${!!folder} ignored=${ignored} storeHit=${!!status} sev=${status?.severity ?? 'none'} uriKey=${uriKey}`);

    try {
      if (this.config && !this.config.enabled) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonDisabled++;
        this._log('  -> RETURN: disabled by config');
        return undefined;
      }

      if (!status) {
        if (ignored) {
          forensicCounters.returnUndefined++;
          forensicCounters.reasonIgnored++;
          this._log('  -> RETURN: ignored by pattern');
          return undefined;
        }
      } else {
        this._log(`  store HIT: sev=${status.severity}`);
      }

      if (!status || status.severity === ProblemSeverity.None) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonNoStatus++;
        this._log('  -> RETURN: no status / None severity');
        return undefined;
      }

      if (
        this.config &&
        !this.config.showWarnings &&
        status.severity !== ProblemSeverity.Error
      ) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonShowWarnings++;
        this._log('  -> RETURN: showWarnings=false');
        return undefined;
      }

      const deco = this.toDecoration(status);
      if (!deco) {
        forensicCounters.returnUndefined++;
        this._log('  -> RETURN: toDecoration returned undefined');
        return undefined;
      }
      forensicCounters.returnDecoration++;
      this._log(`[FORENSIC:Step6] DECORATION: badge="${deco.badge ?? 'none'}" badgeLength=${(deco.badge ?? '').length} tooltip="${deco.tooltip}" color=${deco.color?.id ?? 'none'} propagate=${deco.propagate}`);
      this._log(`  -> RETURNING decoration badge="${deco.badge ?? 'none'}" color=${deco.color?.id ?? 'none'}`);
      return deco;
    } catch (err: unknown) {
      forensicCounters.returnUndefined++;
      forensicCounters.reasonException++;
      this._log(`  -> EXCEPTION: ${err instanceof Error ? err.message : String(err)}`);
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
      // Full refresh — flush pending coalesced URIs first, then fire undefined
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
    forensicCounters.fireDidChangeCalls++;
    const now = new Date().toISOString();
    if (uris === undefined) {
      forensicCounters.fireDidChangeUndefined++;
      this._log(`[FORENSIC:Step4] fireDidChange #${forensicCounters.fireDidChangeCalls} UNDEFINED (full refresh) time=${now}`);
    } else if (Array.isArray(uris)) {
      forensicCounters.fireDidChangeArray++;
      this._log(`[FORENSIC:Step4] fireDidChange #${forensicCounters.fireDidChangeCalls} Array(${uris.length}) time=${now}`);
      for (let i = 0; i < Math.min(uris.length, 10); i++) {
        this._log(`[FORENSIC:Step4]   uri[${i}]=${uris[i].toString(true)}`);
      }
      if (uris.length > 10) {
        this._log(`[FORENSIC:Step4]   ... and ${uris.length - 10} more`);
      }
    } else {
      forensicCounters.fireDidChangeSingle++;
      this._log(`[FORENSIC:Step4] fireDidChange #${forensicCounters.fireDidChangeCalls} single URI=${uris.toString(true)} time=${now}`);
    }
    this._onDidChangeFileDecorations.fire(uris);
  }

  private _scheduleCoalescedFire(): void {
    if (this._coalesceTimer !== undefined) return;
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = undefined;
      this._flushCoalesced();
    }, 0);
  }

  private _flushCoalesced(): void {
    if (this._coalescedUris.size === 0) return;
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
