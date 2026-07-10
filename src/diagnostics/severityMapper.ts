import {
  Diagnostic,
  DiagnosticSeverity,
} from 'vscode';
import { ProblemSeverity, ProblemStatus } from '../core/types';

const SEVERITY_MAP: Record<DiagnosticSeverity, ProblemSeverity> = {
  [DiagnosticSeverity.Error]: ProblemSeverity.Error,
  [DiagnosticSeverity.Warning]: ProblemSeverity.Warning,
  [DiagnosticSeverity.Information]: ProblemSeverity.Info,
  [DiagnosticSeverity.Hint]: ProblemSeverity.Info,
};

/** Compute the highest severity present across a set of diagnostics (ignores counts) */
export function toProblemSeverity(diagnostics: readonly Diagnostic[]): ProblemSeverity {
  let max: ProblemSeverity = ProblemSeverity.None;

  for (let i = 0; i < diagnostics.length; i++) {
    const mapped = SEVERITY_MAP[diagnostics[i].severity];
    if (mapped > max) {
      max = mapped;
    }
  }

  return max;
}

/**
 * Convert a raw `Diagnostic[]` array into an immutable `ProblemStatus` value,
 * computing worst severity and summing counts by category.
 * Handles thousands of diagnostics efficiently with a single pass.
 */
export function toProblemStatus(diagnostics: readonly Diagnostic[]): ProblemStatus {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let maxSeverity: ProblemSeverity = ProblemSeverity.None;

  for (let i = 0; i < diagnostics.length; i++) {
    const d = diagnostics[i];
    switch (d.severity) {
      case DiagnosticSeverity.Error:
        errorCount++;
        maxSeverity = ProblemSeverity.Error;
        break;
      case DiagnosticSeverity.Warning:
        warningCount++;
        if (maxSeverity < ProblemSeverity.Warning) {
          maxSeverity = ProblemSeverity.Warning;
        }
        break;
      case DiagnosticSeverity.Information:
      case DiagnosticSeverity.Hint:
        infoCount++;
        if (maxSeverity < ProblemSeverity.Info) {
          maxSeverity = ProblemSeverity.Info;
        }
        break;
    }
  }

  return {
    severity: maxSeverity,
    errorCount,
    warningCount,
    infoCount,
  };
}
