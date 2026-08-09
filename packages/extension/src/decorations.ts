import { ProblemSeverity } from '@pe/core';

import type { ProblemSummary } from '@pe/api';

import { getBadge } from './badge.js';
import type { BadgeStyle } from './badge.js';
import { COLORS } from './constants.js';
import type { ExtensionConfig } from './config.js';

/** The URI shape decorations need (satisfied by vscode.Uri). */
export interface DecorationUriLike {
  readonly fsPath: string;
  readonly path: string;
  toString(): string;
}

/** Engine summary source — just `api.getProblems(uri)`. */
export interface SummarySource {
  getProblems(uri: unknown): ProblemSummary | undefined;
}

/** Consumer-facing decoration; `color` is a workbench color KEY. */
export interface RenderDecoration {
  readonly badge: string | undefined;
  readonly color: string;
  readonly tooltip: string;
}

/**
 * Decoration engine reading the @pe DiagnosticsAPI.
 * Zero vscode imports — extension.ts owns the FileDecorationProvider
 * adapter and the change-event emitter.
 *
 * Badge rules mirror v1: any file with problems gets a badge unless
 * `showWarnings` is off and the file has no errors. Ignore patterns only
 * gate scans (the engine), not already-present badges.
 */
export class DecorationEngine {
  private config: ExtensionConfig | undefined;
  private updater: ((uris: readonly unknown[] | undefined) => void) | undefined;
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly coalesced = new Set<string>();

  constructor(
    private readonly summarySource: SummarySource,
    private readonly folderPredicate: (uri: unknown) => boolean,
  ) {}

  setConfig(config: ExtensionConfig | undefined): void {
    this.config = config;
  }

  /** vscode adapter calls this for every URI the explorer displays. */
  provideFileDecoration(uri: DecorationUriLike): RenderDecoration | undefined {
    const cfg = this.config;
    if (cfg && !cfg.enabled) {
      return undefined;
    }
    if (!this.folderPredicate(uri)) {
      return undefined;
    }

    const status = this.summarySource.getProblems(uri);
    if (!status || status.severity === ProblemSeverity.None) {
      return undefined;
    }
    if (cfg?.showWarnings === false && status.severity !== ProblemSeverity.Error) {
      return undefined;
    }

    const color = colorForSeverity(status.severity);
    let badge = getBadge(status.severity, status, cfg?.badgeStyle ?? 'letter');
    if (badge.length > 2) {
      badge = '9+';
    }

    return { badge: badge.length > 0 ? badge : undefined, color, tooltip: formatTooltip(status) };
  }

  /** Coalesced change notification; `undefined` = full invalidation. */
  notifyChanged(uris: readonly unknown[] | undefined): void {
    if (uris === undefined) {
      this.flushCoalesced();
      this.updater?.(undefined);
      return;
    }
    for (const uri of uris) {
      this.coalesced.add(String(uri));
    }
    if (this.coalesceTimer === undefined) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = undefined;
        this.flushCoalesced();
      }, 0);
    }
  }

  private flushCoalesced(): void {
    if (this.coalesced.size === 0) {
      return;
    }
    const uris = Array.from(this.coalesced, (s) => ({ path: s }));
    this.coalesced.clear();
    this.updater?.(uris);
  }

  /** The vscode adapter registers its `onDidChangeFileDecorations` emitter here. */
  setUpdater(updater: (uris: readonly unknown[] | undefined) => void): void {
    this.updater = updater;
  }

  dispose(): void {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.coalesced.clear();
  }
}

function formatTooltip(status: ProblemSummary): string {
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

function colorForSeverity(severity: ProblemSeverity): string {
  switch (severity) {
    case ProblemSeverity.Error:
      return COLORS.ERROR_FOREGROUND;
    case ProblemSeverity.Warning:
      return COLORS.WARNING_FOREGROUND;
    default:
      return COLORS.INFO_FOREGROUND;
  }
}