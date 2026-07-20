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
import { chainCounters } from '../forensicLogger';
import { debugLog } from '../core/debug';

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
    const ts = Date.now();
    forensicCounters.provideFileDecorationCalls++;
    const callNum = forensicCounters.provideFileDecorationCalls;
    const fsPath = uri.fsPath;
    const configEnabled = this.config?.enabled ?? true;
    const folder = this.delegate.getWorkspaceFolder(uri);
    const status = this.problemStore.get(uri);
    debugLog(`[AUDIT:${ts}] DECO.provideFileDecoration() #${callNum} uri=${fsPath.split('\\').pop() || fsPath} enabled=${configEnabled} wsFolder=${!!folder} storeHit=${!!status} sev=${status?.severity ?? 'none'}`);

    if (!folder) {
      forensicCounters.returnUndefined++;
      forensicCounters.reasonNoWsFolder++;
      debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN undefined — no workspace folder`);
      return undefined;
    }

    const ignored = isIgnored(uri, this.config?.ignorePatterns);

    try {
      if (this.config && !this.config.enabled) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonDisabled++;
        debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN undefined — disabled by config`);
        return undefined;
      }

      if (!status) {
        if (ignored) {
          forensicCounters.returnUndefined++;
          forensicCounters.reasonIgnored++;
          debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN undefined — ignored by pattern`);
          return undefined;
        }
      }

      if (!status || status.severity === ProblemSeverity.None) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonNoStatus++;
        debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN undefined — no status / None severity`);
        return undefined;
      }

      if (
        this.config &&
        !this.config.showWarnings &&
        status.severity !== ProblemSeverity.Error
      ) {
        forensicCounters.returnUndefined++;
        forensicCounters.reasonShowWarnings++;
        debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN undefined — showWarnings=false`);
        return undefined;
      }

      const deco = this.toDecoration(status);
      if (!deco) {
        forensicCounters.returnUndefined++;
        debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN undefined — toDecoration returned undefined`);
        return undefined;
      }
      forensicCounters.returnDecoration++;
      const decoStr = `badge="${deco.badge ?? 'none'}" tooltip="${deco.tooltip}" color=${deco.color?.id ?? 'none'}`;
      debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} RETURN ${decoStr} elapsed=${Date.now() - ts}ms`);
      return deco;
    } catch (err: unknown) {
      forensicCounters.returnUndefined++;
      forensicCounters.reasonException++;
      debugLog(`[AUDIT:${Date.now()}] DECO.provideFileDecoration() #${callNum} EXCEPTION: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Fire decoration change events with coalescing: multiple calls in the same
   * tick are merged into a single array fire, reducing VS Code Explorer
   * invalidation requests.
   */
  fireDidChange(uris: Uri | Uri[] | undefined): void {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] DECO.fireDidChange() ENTER type=${uris === undefined ? 'undefined' : Array.isArray(uris) ? `Array(${uris.length})` : 'single'} coalescedUris=${this._coalescedUris.size} hasTimer=${this._coalesceTimer !== undefined}`);
    if (uris === undefined) {
      debugLog(`[AUDIT:${Date.now()}] DECO.fireDidChange() full refresh — flushing coalesced then firing undefined`);
      this._flushCoalesced();
      this._fire(undefined);
      return;
    }

    if (Array.isArray(uris)) {
      if (uris.length > 0) { chainCounters.fireDidChangeWithUris++; }
      for (let i = 0; i < uris.length; i++) {
        this._coalescedUris.add(uris[i].toString());
      }
      debugLog(`[AUDIT:${Date.now()}] DECO.fireDidChange() added ${uris.length} URIs to coalesced set, now=${this._coalescedUris.size}`);
    } else {
      chainCounters.fireDidChangeWithUris++;
      this._coalescedUris.add(uris.toString());
      debugLog(`[AUDIT:${Date.now()}] DECO.fireDidChange() added 1 URI to coalesced set, now=${this._coalescedUris.size}`);
    }

    this._scheduleCoalescedFire();
    debugLog(`[AUDIT:${Date.now()}] DECO.fireDidChange() RETURN (coalesced fire scheduled) elapsed=${Date.now() - ts}ms`);
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
    const ts = Date.now();
    forensicCounters.fireDidChangeCalls++;
    if (uris === undefined) {
      forensicCounters.fireDidChangeUndefined++;
      debugLog(`[AUDIT:${ts}] DECO._fire() UNDEFINED (full refresh) call#=${forensicCounters.fireDidChangeCalls} storeSize=${this.problemStore.size()}`);
    } else if (Array.isArray(uris)) {
      forensicCounters.fireDidChangeArray++;
      debugLog(`[AUDIT:${ts}] DECO._fire() Array(${uris.length}) call#=${forensicCounters.fireDidChangeCalls} storeSize=${this.problemStore.size()}`);
      for (let i = 0; i < Math.min(uris.length, 5); i++) {
        debugLog(`[AUDIT:${ts}] DECO._fire()   [${i}]=${uris[i].fsPath.split('\\').pop() || uris[i].fsPath}`);
      }
      if (uris.length > 5) {
        debugLog(`[AUDIT:${ts}] DECO._fire()   ... and ${uris.length - 5} more`);
      }
    } else {
      forensicCounters.fireDidChangeSingle++;
      debugLog(`[AUDIT:${ts}] DECO._fire() single uri=${uris.fsPath}`);
    }
    debugLog(`[AUDIT:${Date.now()}] DECO._fire() → _onDidChangeFileDecorations.fire()`);
    this._onDidChangeFileDecorations.fire(uris);
    debugLog(`[AUDIT:${Date.now()}] DECO._fire() RETURN elapsed=${Date.now() - ts}ms`);
  }

  private _scheduleCoalescedFire(): void {
    const ts = Date.now();
    if (this._coalesceTimer !== undefined) {
      debugLog(`[AUDIT:${ts}] DECO._scheduleCoalescedFire() SKIP — timer already pending`);
      return;
    }
    debugLog(`[AUDIT:${ts}] DECO._scheduleCoalescedFire() setting setTimeout(0) coalescedUris=${this._coalescedUris.size}`);
    this._coalesceTimer = setTimeout(() => {
      const fireTs = Date.now();
      debugLog(`[AUDIT:${fireTs}] DECO._scheduleCoalescedFire() timer FIRED (latency=${fireTs - ts}ms)`);
      this._coalesceTimer = undefined;
      this._flushCoalesced();
    }, 0);
  }

  private _flushCoalesced(): void {
    const ts = Date.now();
    debugLog(`[AUDIT:${ts}] DECO._flushCoalesced() ENTER coalescedUris=${this._coalescedUris.size}`);
    if (this._coalescedUris.size === 0) {
      debugLog(`[AUDIT:${ts}] DECO._flushCoalesced() EARLY RETURN — no coalesced URIs`);
      return;
    }
    const uris = Array.from(this._coalescedUris, (s) => Uri.parse(s));
    this._coalescedUris.clear();
    debugLog(`[AUDIT:${Date.now()}] DECO._flushCoalesced() → _fire(${uris.length} URIs)`);
    this._fire(uris);
    debugLog(`[AUDIT:${Date.now()}] DECO._flushCoalesced() RETURN elapsed=${Date.now() - ts}ms`);
  }

  private toDecoration(status: ProblemState): FileDecoration | undefined {
    const ts = Date.now();
    let color: ThemeColor;
    let badge: string;
    let severityLabel: string;

    switch (status.severity) {
      case ProblemSeverity.Error:
        color = new ThemeColor(COLORS.ERROR_FOREGROUND);
        badge = BADGE_LETTERS.error;
        severityLabel = 'Error';
        break;
      case ProblemSeverity.Warning:
        color = new ThemeColor(COLORS.WARNING_FOREGROUND);
        badge = BADGE_LETTERS.warning;
        severityLabel = 'Warning';
        break;
      case ProblemSeverity.Info:
        color = new ThemeColor(COLORS.INFO_FOREGROUND);
        badge = BADGE_LETTERS.info;
        severityLabel = 'Info';
        break;
      default:
        debugLog(`[AUDIT:${ts}] DECO.toDecoration() RETURN undefined — unknown severity=${status.severity}`);
        return undefined;
    }

    const style = this.config?.badgeStyle ?? 'letter';
    debugLog(`[AUDIT:${ts}] DECO.toDecoration() severity=${severityLabel} errors=${status.errorCount} warnings=${status.warningCount} infos=${status.infoCount} fileCount=${status.fileCount} style=${style} initialBadge="${badge}"`);

    if (style !== 'letter') {
      badge = getBadge(status.severity, status, style);
      debugLog(`[AUDIT:${Date.now()}] DECO.toDecoration() non-letter style="${style}" — getBadge returned "${badge}"`);
    }
    if (badge.length > 2) {
      const before = badge;
      badge = '9+';
      debugLog(`[AUDIT:${Date.now()}] DECO.toDecoration() badge truncated "${before}" → "${badge}" (length > 2)`);
    }

    const tooltip = this.formatTooltip(status);
    debugLog(`[AUDIT:${Date.now()}] DECO.toDecoration() RETURN badge="${badge}" color=${color.id} tooltip="${tooltip}" elapsed=${Date.now() - ts}ms`);

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
