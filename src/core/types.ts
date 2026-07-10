export enum ProblemSeverity {
  None = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
}

export interface ProblemStatus {
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
}

export interface Config {
  readonly enabled: boolean;
  readonly showWarnings: boolean;
  readonly badgeStyle: 'letter' | 'count' | 'dot' | 'none';
  readonly ignorePatterns: string[];
  readonly errorColor: string | undefined;
  readonly warningColor: string | undefined;
  readonly infoColor: string | undefined;
}

export type SeverityCounts = Pick<ProblemStatus, 'errorCount' | 'warningCount' | 'infoCount'>;
