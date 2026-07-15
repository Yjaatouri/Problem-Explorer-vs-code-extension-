import { ProblemSeverity } from '../core/types';

export interface TscDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: ProblemSeverity;
  readonly code: string;
  readonly message: string;
}

const DIAGNOSTIC_LINE_RE = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

export class TscOutputParser {
  parse(text: string): TscDiagnostic[] {
    const diagnostics: TscDiagnostic[] = [];
    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      const diag = this.parseLine(trimmed);
      if (diag) {
        diagnostics.push(diag);
      }
    }

    return diagnostics;
  }

  private parseLine(line: string): TscDiagnostic | undefined {
    const match = DIAGNOSTIC_LINE_RE.exec(line);
    if (!match) return undefined;

    const file = match[1];
    const lineNum = parseInt(match[2], 10);
    const column = parseInt(match[3], 10);
    const rawSeverity = match[4];
    const code = match[5];
    const message = match[6];

    if (isNaN(lineNum) || isNaN(column)) return undefined;

    return {
      file,
      line: lineNum,
      column,
      severity: severityMap[rawSeverity] ?? ProblemSeverity.Error,
      code,
      message,
    };
  }
}

const severityMap: Record<string, ProblemSeverity> = {
  error: ProblemSeverity.Error,
  warning: ProblemSeverity.Warning,
};
