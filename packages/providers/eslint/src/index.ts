// @pe/provider-eslint — ESLint diagnostics via `eslint --format json`.
//
// The JSON output contract is stable across eslint 7–9: an array of files,
// each with `messages[]` carrying `line`, `column`, `severity` (1 warn,
// 2 error), `ruleId`, `message`. File-listing (EST linting a directory)
// happens on the product side; this provider always scans the passed paths.

import type { ParsedIssue, ProviderConfig } from '@pe/provider-base';
import { BaseProvider } from '@pe/provider-base';
import type { ScanContext } from '@pe/provider-sdk';
import { ConfidenceTier } from '@pe/provider-sdk';

interface EslintJsonMessage {
  readonly line?: number;
  readonly column?: number;
  readonly severity: 1 | 2;
  readonly ruleId: string | null;
  readonly message: string;
}

interface EslintJsonFile {
  readonly filePath: string;
  readonly messages: readonly EslintJsonMessage[];
}

export function parseEslintJson(stdout: string): ParsedIssue[] {
  let files: EslintJsonFile[];
  try {
    files = JSON.parse(stdout) as EslintJsonFile[];
  } catch {
    return [];
  }
  const issues: ParsedIssue[] = [];
  for (const file of files) {
    for (const msg of file.messages) {
      issues.push({
        file: file.filePath,
        line: msg.line,
        column: msg.column,
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: msg.message,
        ...(msg.ruleId !== null ? { code: msg.ruleId } : {}),
      });
    }
  }
  return issues;
}

const BASE_ARGS = ['--format', 'json', '--no-color'] as const;

function buildCommand(
  context: ScanContext,
  config: Readonly<ProviderConfig>,
): readonly string[] | null {
  const uris = context.uris ?? [];
  if (uris.length === 0) return null;
  const extra = (config.extraArgs ?? []) as readonly string[];
  const paths = uris.map((u) => u.fsPath);
  return ['eslint', ...BASE_ARGS, ...extra, ...paths];
}

export class EslintProvider extends BaseProvider {
  constructor(config?: ProviderConfig) {
    super({
      id: 'eslint',
      displayName: 'ESLint',
      capabilities: {
        confidenceTier: ConfidenceTier.WorkspaceScanner,
        supportedConfigTypes: ['javascript', 'typescript', 'typescript-react'],
        workspaceScan: true,
        incrementalScan: true,
        realtime: false,
        extensions: [
          '.js',
          '.jsx',
          '.ts',
          '.tsx',
          '.mjs',
          '.cjs',
          '.mts',
          '.cts',
          '.vue',
          '.svelte',
        ],
        cost: 'medium',
      },
      defaultConfig: { enabled: true, extraArgs: [] },
      config,
      buildCommand,
      parseOutput: parseEslintJson,
      healthCommand: ['eslint', '--version'],
    });
  }
}
