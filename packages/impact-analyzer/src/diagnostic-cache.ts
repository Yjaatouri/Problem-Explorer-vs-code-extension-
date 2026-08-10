// DiagnosticCache — the engine's memory of previous scan results.
//
// Owned by the ImpactAnalyzer (§5.3). Its only job is to answer
// "do we need to rescan X?" — it stores scan METADATA (when X was scanned,
// by whom, under what config fingerprint), never diagnostics and never
// scan results. Invalidation is event-driven; the TTL is a safety net only
// (§2, rule: TTL must never be the primary invalidation mechanism).
//
// This package is internal. The cache is never exposed to consumers.

import { normalizeUriKey } from '@pe/core';
import type { Uri } from '@pe/core';

/** Default TTL — maximum age before a result is stale regardless of events. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  readonly providerId: string;
  readonly atMs: number;
  readonly fingerprint?: string;
}

export interface DiagnosticCacheOptions {
  /** Safety-net freshness window (default 24h). */
  readonly ttlMs?: number;
  /** Clock for timestamps; injectable for tests. */
  readonly now?: () => number;
}

export interface ScanMetadata {
  /** Config fingerprint the scan ran under; a different fingerprint = stale. */
  readonly fingerprint?: string;
  /** Override for the recorded timestamp (rarely needed). */
  readonly atMs?: number;
}

export class DiagnosticCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: DiagnosticCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Fresh = scanned since the last relevant event AND within the TTL
   * AND still valid for the current config fingerprint.
   */
  hasFreshResult(uri: Uri, fingerprint?: string): boolean {
    const entry = this.entries.get(normalizeUriKey(uri));
    if (!entry) {
      return false;
    }
    if (
      fingerprint !== undefined &&
      entry.fingerprint !== undefined &&
      entry.fingerprint !== fingerprint
    ) {
      return false;
    }
    return this.now() - entry.atMs < this.ttlMs;
  }

  /** Record that a scan covered a file. */
  recordResult(uri: Uri, providerId: string, metadata: ScanMetadata = {}): void {
    this.entries.set(normalizeUriKey(uri), {
      providerId,
      atMs: metadata.atMs ?? this.now(),
      ...(metadata.fingerprint !== undefined ? { fingerprint: metadata.fingerprint } : {}),
    });
  }

  /** Event-driven invalidation: save, config change, health change, workspace change. */
  invalidate(uri: Uri): void {
    this.entries.delete(normalizeUriKey(uri));
  }

  /** Invalidate every entry under a directory prefix (e.g. a project root, §7.2). */
  invalidatePrefix(uri: Uri): void {
    const prefix = normalizeUriKey(uri) + '/';
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /** Invalidate everything (e.g. workspace root change). */
  invalidateAll(): void {
    this.entries.clear();
  }

  /** Number of cached entries (observability). */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
