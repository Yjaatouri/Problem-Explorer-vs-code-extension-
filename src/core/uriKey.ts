import { Uri } from 'vscode';

/**
 * Produce a canonical string key for a URI so equivalent URIs map to the
 * same cache entry regardless of Windows drive-letter casing or trailing
 * slashes (e.g. `file:///C%3A/x/` and `file:///c%3A/x` share one key).
 */
export function normalizeUriKey(uri: Uri): string {
  let key = uri.toString();

  // Normalize Windows drive letter casing: file:///C%3A/... or file:///C:/...
  key = key.replace(
    /^(file:\/\/\/)([A-Za-z])(%3A|%3a|:)/,
    (_match, prefix: string, drive: string, colon: string) =>
      prefix + drive.toLowerCase() + (colon === ':' ? ':' : '%3A'),
  );

  // Strip trailing slashes (but never the scheme-root slash)
  while (
    key.length > 1 &&
    key.endsWith('/') &&
    !key.endsWith('://') &&
    !key.endsWith(':///')
  ) {
    key = key.slice(0, -1);
  }

  return key;
}
