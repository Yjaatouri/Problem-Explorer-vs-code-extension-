import { Uri } from 'vscode';
import { normalizeUriKey } from '../../../src/core/uriKey';
import type { Experiment } from '../runner';
import { log, logUri } from '../runner';

/**
 * Experiment: verify that URI keys produced by normalizeUriKey match
 * between different representations of the same file (re-parsed URI,
 * different drive-letter casing, trailing slashes).
 *
 * This tests the hypothesis from REVIEW.md Bug #5/#6: a mismatch
 * between the URI key used in fireDidChange(uri) and the URI key
 * used in provideFileDecoration(uri) would cause VS Code to cache
 * undefined decorations permanently.
 */
export const uriNormalizationExperiment: Experiment = () => {
  const filePath = 'file:///workspace/src/file.ts';
  const uri1 = Uri.parse(filePath);
  const uri2 = Uri.parse(filePath);
  const key1 = normalizeUriKey(uri1);
  const key2 = normalizeUriKey(uri2);

  logUri('uri1', uri1);
  logUri('uri2', uri2);

  if (key1 !== key2) {
    return {
      name: 'uriNormalization: same parse produces same key',
      passed: false,
      message: `Key mismatch: "${key1}" !== "${key2}"`,
      durationMs: 0,
    };
  }

  // Round-trip: URI → toString → parse → normalize
  const uri3 = Uri.parse(uri1.toString());
  const key3 = normalizeUriKey(uri3);
  logUri('uri3 (round-trip)', uri3);

  if (key1 !== key3) {
    return {
      name: 'uriNormalization: round-trip produces same key',
      passed: false,
      message: `Key mismatch after round-trip: "${key1}" !== "${key3}"`,
      durationMs: 0,
    };
  }

  // Different drive letter casing (Windows)
  const uriUpper = Uri.parse('file:///C:/workspace/file.ts');
  const uriLower = Uri.parse('file:///c:/workspace/file.ts');
  const keyUpper = normalizeUriKey(uriUpper);
  const keyLower = normalizeUriKey(uriLower);
  logUri('uriUpper (C:)', uriUpper);
  logUri('uriLower (c:)', uriLower);

  if (keyUpper !== keyLower) {
    return {
      name: 'uriNormalization: drive letter casing normalized',
      passed: false,
      message: `Key mismatch: "${keyUpper}" !== "${keyLower}"`,
      durationMs: 0,
    };
  }

  // Trailing slash normalization
  const uriSlash = Uri.parse('file:///workspace/folder/');
  const uriNoSlash = Uri.parse('file:///workspace/folder');
  const keySlash = normalizeUriKey(uriSlash);
  const keyNoSlash = normalizeUriKey(uriNoSlash);
  logUri('uriSlash', uriSlash);
  logUri('uriNoSlash', uriNoSlash);

  if (keySlash !== keyNoSlash) {
    return {
      name: 'uriNormalization: trailing slash normalized',
      passed: false,
      message: `Key mismatch: "${keySlash}" !== "${keyNoSlash}"`,
      durationMs: 0,
    };
  }

  return {
    name: 'uriNormalization: all checks pass',
    passed: true,
    message: 'URI normalization is consistent across parse, round-trip, drive letter, and trailing slash',
    durationMs: 0,
  };
};
