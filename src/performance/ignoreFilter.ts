import { Uri } from 'vscode';
import { minimatch } from 'minimatch';
import { DEFAULT_IGNORE_PATTERNS } from '../core/constants';

/** Check whether a URI matches any of the given ignore glob patterns (defaults to `DEFAULT_IGNORE_PATTERNS`). Non-`file` URIs are never ignored. */
export function isIgnored(uri: Uri, patterns?: string[]): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }

  const list = patterns ?? [...DEFAULT_IGNORE_PATTERNS];
  if (list.length === 0) {
    return false;
  }

  const path = uri.fsPath.replace(/\\/g, '/');
  return list.some((p) => minimatch(path, p, { dot: true }));
}
