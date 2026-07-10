/** Ordering matches worst-severity-wins: None < Info < Warning < Error */
export enum ProblemSeverity {
  None = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
}

/** Immutable value object representing the diagnostics summary for one file or folder */
export interface ProblemStatus {
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  /** Number of files contributing to this status (1 for a single file, aggregated for folders) */
  readonly fileCount: number;
}

/** Shape of the `problemExplorer.*` user settings at runtime */
export interface Config {
  readonly enabled: boolean;
  readonly showWarnings: boolean;
  readonly badgeStyle: 'letter' | 'count' | 'dot' | 'none';
  readonly ignorePatterns: string[];
  readonly errorColor: string | undefined;
  readonly warningColor: string | undefined;
  readonly infoColor: string | undefined;
}

/** Convenience type for badge formatting — just the counts, no severity */
export type SeverityCounts = Pick<ProblemStatus, 'errorCount' | 'warningCount' | 'infoCount'>;
