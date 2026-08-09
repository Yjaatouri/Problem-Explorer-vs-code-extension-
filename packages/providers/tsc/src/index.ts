// TypeScript provider — `tsc` CLI. Provides project (folder) scans and
// per-file incremental scans, and parses `tsc` stdout into issues (§7).

import { statSync } from 'node:fs';

import type { ParsedIssue, ProviderConfig, ScanContext } from '@pe/provider-base';
import { BaseProvider } from '@pe/provider-base';
import { ConfidenceTier } from '@pe/provider-sdk';

export const TSC_DEFAULT_ARGS = ['--noEmit', '--pretty', 'false'] as const;

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');

/** Strip ANSI + Windows CR, then match tsc's `file(line,col): severity TS#### message`. */
export function parseTscOutput(stdout: string): ParsedIssue[] {
  const issues: ParsedIssue[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
    if (line.length === 0) continue;

    const withCode = /^(.*)\((\d+),(\d+)\): (error|warning|info) (TS\d+): (.*)$/.exec(line);
    if (withCode) {
      issues.push({
        file: withCode[1]!,
        line: Number(withCode[2]),
        column: Number(withCode[3]),
        severity: withCode[4] as ParsedIssue['severity'],
        code: withCode[5],
        message: withCode[6]!,
      });
      continue;
    }

    const bare = /^(.*)\((\d+),(\d+)\): (error|warning|info): (.*)$/.exec(line);
    if (bare) {
      issues.push({
        file: bare[1]!,
        line: Number(bare[2]),
        column: Number(bare[3]),
        severity: bare[4] as ParsedIssue['severity'],
        message: bare[5]!,
      });
    }
  }
  return issues;
}

export type TscConfig = ProviderConfig & {
  enabled?: boolean;
  /** Extra argv appended to the scan command (e.g. `--strict`). */
  extraArgs?: readonly string[];
};

function isDirectory(fsPath: string): boolean {
  try {
    return statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

function buildCommand(
  context: ScanContext,
  cfg: Readonly<ProviderConfig>,
): readonly string[] | null {
  const targetPaths = (context.uris ?? []).map((u) => u.fsPath);
  if (targetPaths.length === 0) return null;
  const tsc = cfg as Readonly<TscConfig>;
  const extra = (tsc.extraArgs ?? []) as readonly string[];
  // A lone directory is a project root (full scan); anything else is file-scoped.
  if (targetPaths.length === 1 && isDirectory(targetPaths[0]!)) {
    return ['tsc', ...TSC_ARGS, ...extra, '--project', targetPaths[0]!];
  }
  // File-scope: modern tsc refuses to run files while a tsconfig.json sits in
  // the path tree (TS5112) — `--ignoreConfig` opts out so per-file scans work
  // in project workspaces.
  return ['tsc', ...TSC_ARGS, '--ignoreConfig', ...extra, ...targetPaths];
}

const TSC_ARGS: readonly string[] = ['--noEmit', '--pretty', 'false'];

/** Direct access to the argv builder (used by host code and tests). */
export function buildTscCommand(
  context: ScanContext,
  cfg: Readonly<TscConfig>,
): readonly string[] | null {
  return buildCommand(context, cfg);
}

export class TscProvider extends BaseProvider {
  constructor(config?: TscConfig) {
    super({
      id: 'tsc',
      displayName: 'TypeScript',
      capabilities: {
        confidenceTier: ConfidenceTier.WorkspaceScanner,
        supportedConfigTypes: ['typescript', 'typescript-react'],
        workspaceScan: true,
        incrementalScan: true,
        realtime: false,
        extensions: ['.ts', '.tsx', '.mts', '.cts', '.d.ts'],
        cost: 'expensive',
      },
      defaultConfig: { enabled: true, extraArgs: [] },
      config,
      buildCommand: buildCommand,
      parseOutput: parseTscOutput,
      healthCommand: ['tsc', '--version'],
    });
  }
}
