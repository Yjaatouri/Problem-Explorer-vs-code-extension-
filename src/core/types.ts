/** Ordering matches worst-severity-wins: None < Info < Warning < Error */
export enum ProblemSeverity {
  None = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
}

/** Immutable value object representing the diagnostics summary for one file or folder */
export interface ProblemState {
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  /** Number of files contributing to this state (1 for a single file, aggregated for folders) */
  readonly fileCount: number;
}

export interface TscConfig {
  readonly enabled: boolean;
  readonly autoScan: boolean;
  readonly scanOnStartup: boolean;
  readonly timeout: number;
  readonly useWorkspaceVersion: boolean;
  readonly maxConcurrentScans: number;
}

export interface EslintConfig {
  readonly enabled: boolean;
  readonly autoScan: boolean;
  readonly timeout: number;
}

export interface Config {
  readonly enabled: boolean;
  readonly showWarnings: boolean;
  readonly badgeStyle: 'letter' | 'count' | 'dot' | 'none';
  readonly ignorePatterns: string[];
  readonly errorColor: string | undefined;
  readonly warningColor: string | undefined;
  readonly infoColor: string | undefined;
  /**
   * Per-file-extension severity overrides.
   * Keys are file extensions (e.g. ".py"), values map source severity names to target severity names.
   * Example: `{ ".py": { "Error": "Warning" } }` demotes Python errors to warnings.
   */
  readonly severityOverrides: Record<string, Record<string, string>> | undefined;
  readonly typescript: TscConfig;
  readonly eslint: EslintConfig;
}

/** Convenience type for badge formatting — just the counts, no severity */
export type SeverityCounts = Pick<ProblemState, 'errorCount' | 'warningCount' | 'infoCount'>;
