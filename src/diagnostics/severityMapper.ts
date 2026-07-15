import {
  Diagnostic,
  DiagnosticSeverity,
  Uri,
} from 'vscode';
import { ProblemSeverity, ProblemState } from '../core/types';

const SEVERITY_NAME_MAP: Record<string, DiagnosticSeverity> = {
  'Error': DiagnosticSeverity.Error,
  'Warning': DiagnosticSeverity.Warning,
  'Information': DiagnosticSeverity.Information,
  'Hint': DiagnosticSeverity.Hint,
};

/**
 * Apply per-extension severity overrides to a diagnostics array.
 * Returns a new array if any overrides were applied, or the original array if none.
 */
export function applySeverityOverrides(
  uri: Uri,
  diagnostics: readonly Diagnostic[],
  overrides: Record<string, Record<string, string>> | undefined,
): readonly Diagnostic[] {
  if (!overrides) {
    return diagnostics;
  }

  const match = uri.fsPath.match(/\.([\w.]+)$/);
  if (!match) {
    return diagnostics;
  }
  const ext = '.' + match[1];
  const mapping = overrides[ext];
  if (!mapping) {
    return diagnostics;
  }

  const result: Diagnostic[] = [];
  let changed = false;
  for (let i = 0; i < diagnostics.length; i++) {
    const d = diagnostics[i];
    const targetName = mapping[DiagnosticSeverity[d.severity]];
    if (!targetName) {
      result.push(d);
      continue;
    }
    const targetSeverity = SEVERITY_NAME_MAP[targetName];
    if (targetSeverity === undefined || targetSeverity === d.severity) {
      result.push(d);
      continue;
    }
    const clone = new Diagnostic(d.range, d.message, targetSeverity);
    clone.source = d.source;
    clone.code = d.code;
    clone.relatedInformation = d.relatedInformation;
    clone.tags = d.tags;
    result.push(clone);
    changed = true;
  }

  return changed ? result : diagnostics;
}

/**
 * Convert a raw `Diagnostic[]` array into an immutable `ProblemState` value,
 * computing worst severity and summing counts by category.
 * Handles thousands of diagnostics efficiently with a single pass.
 */
export function toProblemState(diagnostics: readonly Diagnostic[]): ProblemState {
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
        infoCount++;
        if (maxSeverity < ProblemSeverity.Info) {
          maxSeverity = ProblemSeverity.Info;
        }
        break;
      case DiagnosticSeverity.Hint:
        // Hints are intentionally ignored — they don't contribute to counts or severity
        break;
    }
  }

  const hasAny = errorCount + warningCount + infoCount > 0;

  return {
    severity: maxSeverity,
    errorCount,
    warningCount,
    infoCount,
    fileCount: hasAny ? 1 : 0,
  };
}
