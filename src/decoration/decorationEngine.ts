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
import { ProblemStore } from '../store/ProblemStore';
import { Config, ProblemSeverity, ProblemState } from '../core/types';
import { COLORS, BADGE_LETTERS } from '../core/constants';
import { getBadge } from './badgeFormatter';
import { isIgnored } from '../performance/ignoreFilter';
import { toProblemState, applySeverityOverrides } from '../diagnostics/severityMapper';
import { normalizeUriKey } from '../core/uriKey';
import { forensicLog } from '../forensicLogger';

// ----- FORENSIC COUNTERS -----
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

export class DecorationEngine implements FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new EventEmitter<Uri | Uri[] | undefined>();
  readonly onDidChangeFileDecorations: Event<Uri | Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;
  private severityOverrides: Record<string, Record<string, string>> | undefined;
  private config: Config | undefined;
  private readonly _log: (msg: string) => void;

  constructor(
    private readonly cache: ProblemCache,
    private readonly problemStore: ProblemStore,
    log?: (msg: string) => void,
  ) {
    this._log = log ?? (() => { /* no-op */ });
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
    forensicCounters.provideFileDecorationCalls++;
    const callNum = forensicCounters.provideFileDecorationCalls;
    const now = new Date().toISOString();
    const fsPath = uri.fsPath;
    const configEnabled = this.config?.enabled ?? true;
    const folder = workspace.getWorkspaceFolder(uri);

    const explorerUriStr = uri.toString(true);

    if (!folder) {
      forensicCounters.returnUndefined++;
      forensicCounters.reasonNoWsFolder++;
      this._log(`[FORENSIC:Step5] provideFileDecoration #${callNum} URI=${explorerUriStr} time=${now}`);
      this._log('  -> RETURN: no workspace folder');
      return undefined;
    }

    const ignored = isIgnored(uri, this.config?.ignorePatterns);
    const cacheStatus = this.cache.get(uri, folder.uri);
    const diagnostics = languages.getDiagnostics(uri);
    const diagLen = diagnostics.length;
    const uriKey = normalizeUriKey(uri);
    const folderKey = normalizeUriKey(folder.uri);

    // Step 8: URI consistency log
    this._log(`[FORENSIC:Step8] URI consistency: explorerUri=${uri.toString(true)} fsPath=${fsPath} uriKey=${uriKey} folderKey=${folderKey} scheme=${uri.scheme} authority=${uri.authority}`);

    this._log(`[FORENSIC:Step5] provideFileDecoration #${callNum} URI=${explorerUriStr} time=${now} enabled=${configEnabled} wsFolder=${!!folder} ignored=${ignored} cacheHit=${!!cacheStatus} diagLen=${diagLen} cacheSeverity=${cacheStatus?.severity ?? 'none'} uriKey=${uriKey}`);

    try {
      if (this.config && !this.config.enabled) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonDisabled++;
        this._log('  -> RETURN: disabled by config');
        return undefined;
      }

      let status = this.problemStore.get(uri);

      if (!status) {
        if (ignored) {
          forensicCounters.returnUndefined++;
          forensicCounters.reasonIgnored++;
          this._log('  -> RETURN: ignored by pattern');
          return undefined;
        }
        if (diagLen > 0) {
          const mapped = applySeverityOverrides(uri, diagnostics, this.severityOverrides);
          status = toProblemState(mapped);
          this.problemStore.set(uri, status);
          this.cache.set(uri, status, folder.uri);
          forensicLog(`[FORENSIC:Step5-DEC] provideFileDecoration cache.set: uri=${uri.toString(true)} sev=${status.severity} err=${status.errorCount} warn=${status.warningCount} diagLen=${diagLen}`);
          this._log(`  cached NEW: sev=${status.severity} err=${status.errorCount} warn=${status.warningCount}`);
        }
      } else {
        this._log(`  cache HIT: sev=${status.severity}`);
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

  fireDidChange(uris: Uri | Uri[] | undefined): void {
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

  refresh(): void {
    const now = new Date().toISOString();
    this._log(`[FORENSIC:Step4] refresh() → fireDidChange(undefined) time=${now}`);
    this._onDidChangeFileDecorations.fire(undefined);
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