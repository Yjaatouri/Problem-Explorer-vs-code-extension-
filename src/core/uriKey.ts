import { Uri } from 'vscode';

const uriKeyCache = new Map<string, string>();

/**
 * Produce a canonical string key for a URI so equivalent URIs map to the
 * same cache entry regardless of Windows drive-letter casing or trailing
 * slashes (e.g. `file:///C%3A/x/` and `file:///c%3A/x` share one key).
 *
 * Results are cached per `uri.toString()` input to avoid repeated regex and
 * while-loop overhead for frequently-used URIs.
 */
export function normalizeUriKey(uri: Uri): string {
  const input = uri.toString();
  const cached = uriKeyCache.get(input);
  if (cached !== undefined) return cached;

  let key = input;

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

  uriKeyCache.set(input, key);
  return key;
}

/** Get the parent directory key from a normalized key (cheap string operation, no Uri allocation). */
export function getParentKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash <= 7) return key; // at or above "file:///"
  return key.slice(0, lastSlash);
}

/** Clear the URI key cache (for test isolation / config changes). */
export function clearUriKeyCache(): void {
  uriKeyCache.clear();
}
