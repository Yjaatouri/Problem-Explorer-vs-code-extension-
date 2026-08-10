// BaseProvider — the reusable implementation kit for concrete providers (§7).
//
// A concrete provider is a thin subclass that supplies identity, capabilities,
// a config Schema, the scan argv builder, the stdout parser, and an optional
// health command. BaseProvider owns the mechanical 80%: config defaulting and
// the `enabled` convention, running the tool with timeout/output caps,
// mapping parsed issues to engine Diagnostics (0-based lines/cols), and
// reporting tool failures as scan errors. Every provider therefore gets
// identical runtime semantics by construction.

import { statSync } from 'node:fs';
import * as path from 'node:path';
import type {
  Diagnostic,
  HealthResult,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ScanContext,
  ScanErrorInfo,
  ScanResult,
  ScannedFileDiagnostics,
  Schema,
  Uri,
} from '@pe/provider-sdk';
import { ProblemSeverity, ProviderHealth } from '@pe/provider-sdk';

import { runExecutable } from './runner.js';

/** A raw problem as the tool reports it. Lines/columns are 1-based, as printed. */
export interface ParsedIssue {
  /** Path exactly as the tool printed it (may be relative to the scan cwd). */
  readonly file: string;
  /** 1-based line, if the tool reports lines. */
  readonly line?: number;
  /** 1-based column, if the tool reports columns. */
  readonly column?: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  /** Tool-specific code, e.g. `TS7006`, `no-unused-vars`. */
  readonly code?: string;
}

/** Builds the full argv for a scan; null means the provider opts out of this scan. */
export type ScanCommandBuilder = (
  context: ScanContext,
  config: Readonly<ProviderConfig>,
) => readonly string[] | null;

export interface BaseProviderOptions {
  /** Unique kebab-case id, e.g. `tsc`. */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Full argv including the binary name; null → produce an empty result. */
  readonly buildCommand: ScanCommandBuilder;
  /** Parse the tool's stdout into a list of issues. */
  readonly parseOutput: (stdout: string) => readonly ParsedIssue[];
  /** Working directory the tool runs in; relative report paths resolve against it. */
  readonly cwdFor?: (context: ScanContext) => string | undefined;
  /** JSON Schema for the provider's config (`enabled`, `args`, …). */
  readonly configSchema?: Schema;
  /** Config defaults; the runner honors `enabled: false` and `timeoutMs`. */
  readonly defaultConfig?: Readonly<ProviderConfig>;
  /** Host-supplied config, merged over defaults at scan time. */
  readonly config?: Readonly<ProviderConfig>;
  /** Overrides defaultConfig.timeoutMs (default 30s). */
  readonly timeoutMs?: number;
  /** Full argv for a health check. Absent → provider is trivially Ready. */
  readonly healthCommand?: readonly string[];
  readonly healthCwd?: string;
}

function makeFileUri(fsPath: string): Uri {
  const pathValue = fsPath.replace(/\\/g, '/');
  const withScheme = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  const encodedPath = withScheme
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
    .replace(/^(\/[A-Za-z])(%3A|%3a|:)/, (_m, drive: string) => drive.toLowerCase() + '%3A');
  const uri: Uri = {
    scheme: 'file',
    authority: '',
    path: pathValue,
    fsPath,
    toString: () => `file://${encodedPath}`,
    with: (change) => makeFileUri(change.path ?? fsPath),
  };
  return uri;
}

function severityToProblemSeverity(severity: ParsedIssue['severity']): ProblemSeverity {
  switch (severity) {
    case 'error':
      return ProblemSeverity.Error;
    case 'warning':
      return ProblemSeverity.Warning;
    default:
      return ProblemSeverity.Info;
  }
}

function toDiagnostic(providerId: string, issue: ParsedIssue): Diagnostic {
  return {
    line: Math.max(0, (issue.line ?? 1) - 1),
    column: Math.max(0, (issue.column ?? 1) - 1),
    severity: severityToProblemSeverity(issue.severity),
    message: issue.message,
    source: providerId,
    ...(issue.code !== undefined ? { code: issue.code } : {}),
  };
}

export class BaseProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly configSchema: Schema;
  readonly defaultConfig: Readonly<ProviderConfig>;

  private readonly options: BaseProviderOptions;
  private readonly cwd: string;

  constructor(options: BaseProviderOptions, cwd = process.cwd()) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.capabilities = options.capabilities;
    this.configSchema = options.configSchema ?? { type: 'object' };
    this.defaultConfig = options.defaultConfig ?? {};
    this.options = options;
    this.cwd = cwd;
  }

  async scan(context: ScanContext): Promise<ScanResult> {
    const config = { ...(this.options.defaultConfig ?? {}), ...(this.options.config ?? {}) };
    if (config.enabled === false) {
      return { changedUris: [], files: [] };
    }
    const argv = this.options.buildCommand(context, config);
    if (argv === null || argv.length === 0) {
      return { changedUris: [], files: [] };
    }

    const cwd = this.options.cwdFor?.(context) ?? this.scanCwd(context);
    const result = await runExecutable(argv, {
      cwd,
      timeoutMs: (config.timeoutMs as number | undefined) ?? this.options.timeoutMs ?? 30_000,
    });

    const errors: ScanErrorInfo[] = [];
    if (result.missing) {
      const uri = this.rootUri(context);
      errors.push({
        uri,
        message: `executable not found: ${argv[0]} (add it to PATH or disable provider '${this.id}')`,
        code: 'ENOENT',
      });
    } else {
      let issues: readonly ParsedIssue[] = [];
      try {
        issues = this.options.parseOutput(result.stdout);
      } catch (e) {
        errors.push({
          uri: this.rootUri(context),
          message: `scanner output was not parseable: ${(e as Error).message.slice(0, 200)}`,
        });
      }

      const byFile = new Map<string, Diagnostic[]>();
      for (const issue of issues) {
        const absolute = this.resolveReportedPath(issue.file, cwd);
        const list = byFile.get(absolute);
        const diagnostic = toDiagnostic(this.id, issue);
        if (list === undefined) {
          byFile.set(absolute, [diagnostic]);
        } else {
          list.push(diagnostic);
        }
      }

      const files: ScannedFileDiagnostics[] = [...byFile].map(([filePath, diagnostics]) => ({
        uri: makeFileUri(filePath),
        diagnostics,
      }));

      if (result.code !== 0 && result.code !== null && issues.length === 0) {
        const message = (result.stderr || result.stdout).trim();
        errors.push({
          uri: this.rootUri(context),
          message:
            message.length > 0 ? message.slice(0, 8_000) : `tool exited with code ${result.code}`,
        });
      }

      if (result.timedOut && issues.length === 0) {
        errors.push({
          uri: this.rootUri(context),
          message: `scan timed out after ${(this.options.timeoutMs ?? 30_000) / 1000}s`,
        });
      }

      return {
        changedUris: context.uris ?? [],
        files,
        ...(errors.length > 0 ? { errors } : {}),
      };
    }
    return { changedUris: context.uris ?? [], errors };
  }

  async healthCheck(): Promise<HealthResult> {
    const argv = this.options.healthCommand;
    if (argv === undefined || argv.length === 0) {
      return { health: ProviderHealth.Ready };
    }
    const result = await runExecutable(argv, {
      cwd: this.options.healthCwd ?? this.cwd,
      timeoutMs: 30_000,
    });
    if (result.missing) {
      return {
        health: ProviderHealth.MissingDependency,
        message: `executable not found: ${argv[0]}`,
      };
    }
    if (result.code !== 0 && result.code !== null) {
      return {
        health: ProviderHealth.Unavailable,
        message:
          (result.stderr || result.stdout).trim().slice(0, 500) ||
          `exited with code ${result.code}`,
      };
    }
    return { health: ProviderHealth.Ready };
  }

  dispose(): void {
    // overridden where providers own long-lived processes
  }

  private rootUri(context: ScanContext): Uri {
    const first = context.uris?.[0];
    return first ?? makeFileUri('');
  }

  /**
   * Tools print paths relative to their working directory. The job root is
   * the working dir: a directory scan runs from that root, a file scan from
   * the file's own directory. Without this the extension host's own cwd
   * leaks into (and mangles) reported paths.
   */
  private scanCwd(context: ScanContext): string {
    const first = context.uris?.[0];
    if (first !== undefined) {
      try {
        const stats = statSync(first.fsPath);
        return stats.isDirectory() ? first.fsPath : path.dirname(first.fsPath);
      } catch {
        return this.cwd;
      }
    }
    return this.cwd;
  }

  private resolveReportedPath(reported: string, cwd: string): string {
    if (reported.startsWith('/') || /^[A-Za-z]:[\\/]/.test(reported)) {
      return reported;
    }
    return `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${reported.replace(/\\/g, '/')}`;
  }
}
