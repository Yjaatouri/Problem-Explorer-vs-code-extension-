import { Uri } from 'vscode';
import { ProblemSeverity } from '../core/types';

export interface EslintMessage {
  filePath: string;
  messages: Array<{
    ruleId: string | null;
    severity: 1 | 2;
    message: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    fix?: {
      range: [number, number];
      text: string;
    };
  }>;
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
}

export interface EslintDiagnostic {
  uri: Uri;
  severity: ProblemSeverity;
  message: string;
  ruleId: string | null;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  fixable: boolean;
}

export class EslintOutputParser {
  parse(output: string): EslintDiagnostic[] {
    if (!output.trim()) {
      return [];
    }

    let results: EslintMessage[];
    try {
      results = JSON.parse(output);
    } catch {
      return [];
    }

    const diagnostics: EslintDiagnostic[] = [];

    for (const result of results) {
      if (!result.messages || result.messages.length === 0) {
        continue;
      }

      const uri = Uri.file(result.filePath);

      for (const msg of result.messages) {
        const severity = msg.severity === 2 ? ProblemSeverity.Error : ProblemSeverity.Warning;

        diagnostics.push({
          uri,
          severity,
          message: `[eslint${msg.ruleId ? `(${msg.ruleId})` : ''}] ${msg.message}`,
          ruleId: msg.ruleId,
          range: {
            start: { line: Math.max(0, msg.line - 1), character: Math.max(0, msg.column - 1) },
            end: {
              line: Math.max(0, (msg.endLine ?? msg.line) - 1),
              character: msg.endColumn ? Math.max(0, msg.endColumn - 1) : Math.max(0, msg.column),
            },
          },
          fixable: !!msg.fix,
        });
      }
    }

    return diagnostics;
  }
}