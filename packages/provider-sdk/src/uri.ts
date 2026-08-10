// Structural file URI builder for provider authors (§6.1).
//
// The engine's Uri is structural (modeled on vscode.Uri, never importing it).
// Provider packages are editor-agnostic and must not depend on `vscode`,
// so the SDK provides this small factory. The engine's WorkspaceIndex has an
// identical helper internally; the SDK copy exists so providers never need an
// internal package to build URIs.

import type { Uri } from '@pe/core';

/** Build a structural `file:` Uri from a filesystem path. */
export function fileUriFromPath(fsPath: string): Uri {
  const normalized = fsPath.replace(/\\/g, '/');
  const withScheme = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encodedPath = withScheme
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
    .replace(/^(\/[A-Za-z])(%3A|%3a|:)/, (_m, drive: string) => drive.toLowerCase() + '%3A');
  const uriString = `file://${encodedPath}`;
  const uri: Uri = {
    scheme: 'file',
    authority: '',
    path: withScheme,
    fsPath,
    toString: () => uriString,
    with: (change: { path?: string }) => fileUriFromPath(change.path ?? fsPath),
  };
  return uri;
}
