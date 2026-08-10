// ImpactAnalyzer — the engine's only change-intelligence (§5.8, §7.4).
//
// Converts workspace events into minimal ScanPlans. It never knows provider
// IDs (only capabilities), never reads the ProblemStore, and never runs
// scans. The scheduler is the *when*; this class is the *why*.
//
// Pipeline (§7.4.1–2): per-URI debounce → one global batch window → atomic
// commit → mtime+size diff vs WorkspaceIndex → classify → plan rules → cache
// filter → emit. A no-op save costs one map lookup; a README change never
// wakes the scheduler.

import { DEFAULT_CONFIG_FILES } from '@pe/workspace-index';
import type { WorkspaceIndex } from '@pe/workspace-index';
import { normalizeUriKey, TypedEventEmitter } from '@pe/core';
import type { ConfigType, ScanPlan, ScanPriority, Uri } from '@pe/core';
import { basename, extname } from 'node:path';
import { DiagnosticCache } from './diagnostic-cache.js';

/** Save debounce window (§7.4.1). */
export const DEFAULT_DEBOUNCE_MS = 300;
/** Global batch flush window (§7.4.1). */
export const DEFAULT_BATCH_MS = 500;

export interface ImpactAnalyzerOptions {
  readonly debounceMs?: number;
  readonly batchMs?: number;
  readonly now?: () => number;
}

interface PendingFile {
  readonly uri: Uri;
  readonly mtime?: number;
  readonly size?: number;
}

/**
 * Capability mapping for *source* files, keyed by extension (lowercased).
 * Config files use the rule table below instead.
 */
const EXTENSION_CAPABILITY: Readonly<Record<string, ConfigType>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'javascript',
  '.svelte': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.php': 'php',
  '.cs': 'csharp',
  '.java': 'java',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.c': 'cpp',
};

/**
 * The §5.8 rule table, codified: config file name → capabilities that care.
 * tsconfig.json touches only typescript; package.json touches all JS/TS.
 * Every other config name maps to its DEFAULT_CONFIG_FILES owner.
 */
const CONFIG_CAPABILITIES: Readonly<Record<string, readonly ConfigType[]>> = {
  tsconfig: ['typescript'],
  package: ['typescript', 'javascript'],
  jsconfig: ['javascript'],
};

export class ImpactAnalyzer {
  private readonly index: WorkspaceIndex;
  private readonly cache: DiagnosticCache;
  private readonly debounceMs: number;
  private readonly batchMs: number;
  private readonly now: () => number;
  private readonly planEmitter = new TypedEventEmitter<readonly ScanPlan[]>();
  private pending = new Map<string, PendingFile>();
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(index: WorkspaceIndex, cache: DiagnosticCache, options: ImpactAnalyzerOptions = {}) {
    this.index = index;
    this.cache = cache;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.now = options.now ?? Date.now;
  }

  /** Output: minimal work, emitted to the scheduler (wired by @pe/api). */
  readonly onPlans = this.planEmitter.on.bind(this.planEmitter);

  /**
   * Stage 1 ingestion (§7.4.1): trailing-edge debounce per URI, coalesced.
   * `mtime`/`size` may be omitted for removals — the entry is invalidated.
   */
  onFileChanged(uri: Uri, mtime?: number, size?: number): void {
    if (this.disposed) {
      return;
    }
    const key = normalizeUriKey(uri);
    const existingTimer = this.pendingTimers.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }
    this.pending.set(key, { uri, mtime, size });
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
    }, this.debounceMs);
    timer.unref?.();
    this.pendingTimers.set(key, timer);
    this.ensureBatchWindow();
  }

  /** Immediate re-scan of files owned by a provider whose health changed (§5.8). */
  onProviderHealthChanged(providerId: string): void {
    if (this.disposed) {
      return;
    }
    const owned = this.index
      .listFiles()
      .filter((entry) => entry.owningProviderId === providerId)
      .map((entry) => entry.uri);
    if (owned.length === 0) {
      return;
    }
    const plans: ScanPlan[] = [];
    for (const [capability, uris] of this.groupByCapability(owned)) {
      const stale = this.filterStale(uris);
      if (stale.length === 0) {
        continue;
      }
      this.invalidateUris(stale);
      plans.push({
        capability,
        scope: 'workspace',
        uris: stale,
        priority: 'save',
      });
    }
    if (plans.length > 0) {
      this.planEmitter.fire(Object.freeze(plans));
    }
  }

  /** Workspace roots changed: everything is stale, full rebuild plan (§5.8). */
  onWorkspaceChanged(): void {
    if (this.disposed) {
      return;
    }
    this.cache.invalidateAll();
    const allUris = this.index.listFiles().map((entry) => entry.uri);
    const plans: ScanPlan[] = [];
    for (const [capability, uris] of this.groupByCapability(allUris)) {
      plans.push({ capability, scope: 'workspace', uris, priority: 'startup' });
    }
    if (plans.length > 0) {
      this.planEmitter.fire(Object.freeze(plans));
    }
  }

  /**
   * Consumer-requested scan (manual per §5.7). Bypasses the no-op diff;
   * results are treated as fresh and overwrite (§7.2). No uris = whole
   * workspace.
   */
  requestScan(uris: readonly Uri[] | undefined, priority: ScanPriority = 'manual'): void {
    if (this.disposed) {
      return;
    }
    this.cache.invalidateAll();
    const targets = uris ?? this.index.listFiles().map((entry) => entry.uri);
    const plans = this.buildPlans(targets, priority);
    if (plans.length > 0) {
      this.planEmitter.fire(Object.freeze(plans));
    }
  }

  /** Drop all timers and pending work. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    this.pending.clear();
  }

  private ensureBatchWindow(): void {
    if (this.batchTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      this.batchTimer = undefined;
      this.commitBatch();
    }, this.batchMs);
    timer.unref?.();
    this.batchTimer = timer;
  }

  /** Stage 2 (§7.4.2): atomic swap, no-op diff, classify, plan rules, emit. */
  private commitBatch(): void {
    if (this.disposed) {
      return;
    }
    const batch = this.pending;
    this.pending = new Map();
    for (const key of batch.keys()) {
      const timer = this.pendingTimers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.pendingTimers.delete(key);
      }
    }
    const changes: PendingFile[] = [];
    for (const info of batch.values()) {
      if (info.mtime === undefined || info.size === undefined) {
        // Removed file: no scan can bring it back — just forget it.
        this.cache.invalidate(info.uri);
        continue;
      }
      const entry = this.index.getFile(info.uri);
      if (entry !== undefined && entry.modifiedMs === info.mtime && entry.size === info.size) {
        continue; // no-op save: zero work, scheduler never wakes
      }
      // The save IS the invalidation event (§7.2): a changed file must never
      // be dropped by the cache oracle — it was just modified.
      this.cache.invalidate(info.uri);
      changes.push(info);
    }
    if (changes.length === 0) {
      return;
    }
    const plans = this.buildPlans(
      changes.map((change) => change.uri),
      'save',
    );
    if (plans.length > 0) {
      this.planEmitter.fire(Object.freeze(plans));
    }
  }

  /**
   * The §5.8 rule table. Produces at most #capabilities plans regardless of
   * how many URIs changed. Config files switch to workspace scope for the
   * governing project root; everything else is per-capability file scope.
   */
  private buildPlans(uris: readonly Uri[], priority: ScanPriority): ScanPlan[] {
    const plans: ScanPlan[] = [];
    const filePlanUris = new Map<ConfigType, Uri[]>();
    const workspacePlans = new Map<ConfigType, Map<string, Uri>>();

    for (const uri of uris) {
      const name = basename(uri.path);
      const configCapabilities = this.configCapabilitiesFor(name);
      if (configCapabilities !== undefined) {
        const projectRoot = this.index.getProjectRoot(uri) ?? uri;
        for (const capability of configCapabilities) {
          let roots = workspacePlans.get(capability);
          if (roots === undefined) {
            roots = new Map();
            workspacePlans.set(capability, roots);
          }
          roots.set(normalizeUriKey(projectRoot), projectRoot);
        }
        continue;
      }
      const capability = EXTENSION_CAPABILITY[extname(uri.path).toLowerCase()];
      if (capability === undefined) {
        continue; // 'other' — a README change never wakes the scheduler
      }
      let fileUris = filePlanUris.get(capability);
      if (fileUris === undefined) {
        fileUris = [];
        filePlanUris.set(capability, fileUris);
      }
      fileUris.push(uri);
    }

    for (const [capability, uriList] of filePlanUris) {
      const stale = this.filterStale(uriList);
      if (stale.length === 0) {
        continue;
      }
      this.invalidateUris(stale);
      plans.push({ capability, scope: 'file', uris: stale, priority });
    }
    for (const [capability, rootMap] of workspacePlans) {
      for (const projectRoot of rootMap.values()) {
        this.cache.invalidatePrefix(projectRoot);
      }
      plans.push({
        capability,
        scope: 'workspace',
        uris: [...rootMap.values()],
        priority,
      });
    }
    return plans;
  }

  private configCapabilitiesFor(fileName: string): readonly ConfigType[] | undefined {
    const stem = fileName.split('.')[0]?.toLowerCase();
    if (stem === undefined || stem === '') {
      return undefined;
    }
    const explicit = CONFIG_CAPABILITIES[stem];
    if (explicit !== undefined) {
      return explicit;
    }
    for (const [capability, names] of Object.entries(DEFAULT_CONFIG_FILES)) {
      if (names?.some((name) => name.toLowerCase() === fileName.toLowerCase())) {
        return [capability as ConfigType];
      }
    }
    return undefined;
  }

  /** Drop URIs the cache still considers fresh (§5.8: plan = only stale work). */
  private filterStale(uris: readonly Uri[]): Uri[] {
    return uris.filter((uri) => !this.cache.hasFreshResult(uri));
  }

  private invalidateUris(uris: readonly Uri[]): void {
    for (const uri of uris) {
      this.cache.invalidate(uri);
    }
  }

  private groupByCapability(uris: readonly Uri[]): Map<ConfigType, Uri[]> {
    const groups = new Map<ConfigType, Uri[]>();
    for (const uri of uris) {
      const capability = EXTENSION_CAPABILITY[extname(uri.path).toLowerCase()];
      if (capability === undefined) {
        continue;
      }
      let list = groups.get(capability);
      if (list === undefined) {
        list = [];
        groups.set(capability, list);
      }
      list.push(uri);
    }
    return groups;
  }
}
