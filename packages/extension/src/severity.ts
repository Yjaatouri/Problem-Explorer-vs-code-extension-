import { ProblemSeverity } from '@pe/core';

import type { Diagnostic } from '@pe/api';

export type SourceSeverity = 'Error' | 'Warning' | 'Info';

/** A vscode.Diagnostic-like editor diagnostic (0-based line/character). */
export interface EditorDiagnosticLike {
  readonly severity: 0 | 1 | 2 | 3 | 4;
  readonly message: string;
  readonly source?: string;
  readonly code?: unknown;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
  };
}

const NUMERIC_SEVERITY: Record<number, SourceSeverity> = {
  0: 'Error',
  1: 'Warning',
  2: 'Info',
  3: 'Info',
  4: 'Info',
};

export function toSourceSeverity(value: EditorDiagnosticLike['severity']): SourceSeverity {
  if (typeof value === 'string') {
    return value;
  }
  return NUMERIC_SEVERITY[value] ?? 'Info';
}

function severityValue(name: SourceSeverity): ProblemSeverity {
  switch (name) {
    case 'Error':
      return ProblemSeverity.Error;
    case 'Warning':
      return ProblemSeverity.Warning;
    default:
      return ProblemSeverity.Info;
  }
}

/** Per-file-extension override map, e.g. `{ ".py": { "Error": "Warning" } }`. */
export type SeverityOverrides = Record<string, Record<string, string>>;

export function applyOverrides(
  severity: SourceSeverity,
  extension: string,
  overrides: SeverityOverrides | undefined,
): SourceSeverity {
  const extMap = overrides?.[extension];
  if (!extMap) {
    return severity;
  }
  const target = extMap[severity];
  if (!target) {
    return severity;
  }
  if (target === 'Error' || target === 'Warning' || target === 'Info') {
    return target;
  }
  return severity;
}

export function fileExtension(fsPath: string): string {
  const slash = fsPath.lastIndexOf('/');
  const backslash = fsPath.lastIndexOf('\\');
  const name = fsPath.slice(Math.max(slash, backslash) + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

/** Map an editor diagnostic to the engine's 0-based Diagnostic. */
export function toEngineDiagnostic(
  diagnostic: EditorDiagnosticLike,
  overrides?: SeverityOverrides,
  fsPath?: string,
): Diagnostic {
  const severity = applyOverrides(
    toSourceSeverity(diagnostic.severity),
    fileExtension(fsPath ?? ''),
    overrides,
  );
  return {
    line: Math.max(0, diagnostic.range.start.line),
    column: Math.max(0, diagnostic.range.start.character),
    severity: severityValue(severity),
    message: diagnostic.message,
    source: diagnostic.source ?? 'vscode',
    ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
  };
}