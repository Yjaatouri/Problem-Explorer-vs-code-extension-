// @pe/provider-ruff — Ruff diagnostics via `ruff check --output-format json`.
//
// Ruff emits an array of findings; shape varies slightly across versions:
//   v2.x: `{ file, line, column, message, code }`
//   v1.x/project: `{ filename, location: { row, column }, message, code }`
// Both are parsed. Severity is only ever present when `--output-format
// json` is combined with the no-severity variants; derive by code prefix
// otherwise.

import type { ParsedIssue, ProviderConfig } from '@pe/provider-base';
import { BaseProvider } from '@pe/provider-base';
import type { ScanContext } from '@pe/provider-sdk';
import { ConfidenceTier } from '@pe/provider-sdk';

interface RuffItem {
  readonly file?: string;
  readonly filename?: string;
  readonly line?: number;
  readonly column?: number;
  readonly location?: { readonly row: number; readonly column: number };
  readonly message: string;
  readonly code: string;
  readonly severity?: 'error' | 'warning' | 'info';
}

function severityOf(code: string, severity?: RuffItem['severity']): ParsedIssue['severity'] {
  if (severity !== undefined) return severity;
  // 'W'/'I'/'R'/'C'/'P'/'D'/'B0'/ANN pages are advisory; everything else is an error.
  if (/^[WIRCPD]/.test(code) || /^(ANN|B0|TCH)/.test(code)) return 'warning';
  return 'error';
}

export function parseRuffJson(stdout: string): ParsedIssue[] {
  let items: RuffItem[];
  try {
    items = JSON.parse(stdout) as RuffItem[];
  } catch {
    return [];
  }
  const issues: ParsedIssue[] = [];
  for (const item of items) {
    const file = item.file ?? item.filename;
    if (file === undefined || file.length === 0) continue;
    issues.push({
      file,
      line: item.line ?? item.location?.row,
      column: item.column ?? item.location?.column,
      severity: severityOf(item.code, item.severity),
      message: item.message,
      code: item.code,
    });
  }
  return issues;
}

export function buildCommand(
  context: ScanContext,
  cfg: Readonly<ProviderConfig>,
): readonly string[] | null {
  const uris = context.uris ?? [];
  if (uris.length === 0) return null;
  const extra = (cfg.extraArgs ?? []) as readonly string[];
  const paths = uris.map((u) => u.fsPath);
  return ['ruff', 'check', '--output-format', 'json', ...extra, ...paths];
}

export class RuffProvider extends BaseProvider {
  constructor(config?: ProviderConfig) {
    super({
      id: 'ruff',
      displayName: 'Ruff',
      capabilities: {
        confidenceTier: ConfidenceTier.WorkspaceScanner,
        supportedConfigTypes: ['python'],
        workspaceScan: true,
        incrementalScan: true,
        realtime: false,
        extensions: ['.py', '.pyi'],
        cost: 'cheap',
      },
      defaultConfig: { enabled: true, extraArgs: [] },
      config,
      buildCommand,
      parseOutput: parseRuffJson,
      healthCommand: ['ruff', '--version'],
    });
  }
}
