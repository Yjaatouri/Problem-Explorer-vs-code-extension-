// DiagnosticsAPI — the public consumer surface (§5.7).
//
// Consumers never see ProblemStore, DiagnosticCache, WorkspaceIndex,
// ScanScheduler, or provider internals. This class wires the pipeline
// (the ONLY place the components touch, §3.1):
//   WorkspaceIndex events → ImpactAnalyzer → ScanScheduler → ProblemStore
// and re-exposes the stable event surface. Every subscription is
// consumer-owned; dispose() clears them all (§7.4.5).

import { DiagnosticCache, ImpactAnalyzer } from '@pe/impact-analyzer';
import { ProviderRegistry, ScanScheduler } from '@pe/scheduler';
import { ProblemStore } from '@pe/store';
import { WorkspaceIndex } from '@pe/workspace-index';
import { ProviderHealth, TypedEventEmitter, normalizeUriKey } from '@pe/core';
import type {
  ConfigType,
  Diagnostic,
  Disposable,
  EngineConfig,
  Event,
  FileChange,
  ProblemChangeEvent,
  ProblemSummary,
  ProblemTotals,
  Provider,
  ProviderStatusChangeEvent,
  ScanJobCompleteEvent,
  ScanPlan,
  ScanPriority,
  ScanStateEvent,
  ScanType,
  TotalsChangedEvent,
  Uri,
} from '@pe/core';
import { statSync } from 'node:fs';

export interface DiagnosticsAPIOptions {
  /** The workspace folder to watch (the engine scans beneath this root). */
  readonly workspaceRoot: Uri;
  /** Providers to register (or manifest paths via ProviderRegistry). */
  readonly providers?: readonly Provider[];
  /** Engine tuning knobs (all optional). */
  readonly config?: EngineConfig;
}

const EXTENSION_CAPABILITY: Record<string, ConfigType> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
};

function extensionCapability(uri: Uri): ConfigType | undefined {
  const slash = uri.path.lastIndexOf('/');
  const file = slash >= 0 ? uri.path.slice(slash) : uri.path;
  const dot = file.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_CAPABILITY[file.slice(dot).toLowerCase()];
}

const PRIORITY_BY_SCAN_TYPE: Record<ScanType, ScanPriority> = {
  startup: 'startup',
  save: 'save',
  manual: 'manual',
  periodic: 'periodic',
};

export class DiagnosticsAPI {
  private readonly store: ProblemStore;
  private readonly index: WorkspaceIndex;
  private readonly cache: DiagnosticCache;
  private readonly analyzer: ImpactAnalyzer;
  private readonly registry: ProviderRegistry;
  private readonly scheduler: ScanScheduler;
  private readonly workspaceRoot: Uri;
  private readonly realtimeProviderId: string | undefined;
  private readonly providerStatusEmitter = new TypedEventEmitter<ProviderStatusChangeEvent>();
  private readonly subscriptions: Disposable[] = [];

  constructor(options: DiagnosticsAPIOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.store = new ProblemStore();
    this.index = new WorkspaceIndex({ roots: [options.workspaceRoot] });
    this.index.load();
    this.index.rebuildDiagnostics();
    this.cache = new DiagnosticCache();
    this.analyzer = new ImpactAnalyzer(this.index, this.cache, {
      debounceMs: options.config?.debounceMs,
      batchMs: options.config?.batchMs,
    });
    this.registry = new ProviderRegistry();
    for (const provider of options.providers ?? []) {
      this.registry.register(provider);
    }
    const realtime = this.registry.all().find((provider) => provider.capabilities.realtime);
    this.realtimeProviderId = realtime?.id;
    this.scheduler = new ScanScheduler({
      registry: this.registry,
      maxConcurrency: options.config?.maxConcurrency,
      queueSize: options.config?.queueSize,
      idleWindowMs: options.config?.idleWindowMs,
      scanTimeoutMs: options.config?.scanTimeoutMs,
    });

    this.subscriptions.push(
      this.index.onDidChangeFiles((event) => this.handleFileChanges(event.changes)),
      this.analyzer.onPlans((plans) => this.enqueuePlans(plans)),
      this.scheduler.onScanJobComplete((event) => this.applyResult(event)),
      this.registry.onStatusChanged((event) => {
        this.analyzer.onProviderHealthChanged(event.providerId);
        this.providerStatusEmitter.fire(event);
      }),
    );

    void this.registry.healthCheckAll();

    this.onProblemsChanged = this.store.onDiagnosticsChanged;
    this.onTotalsChanged = this.store.onTotalsChanged;
    this.onScanStateChanged = this.scheduler.onScanStateChanged;
    this.onProviderStatusChanged = this.providerStatusEmitter.on.bind(this.providerStatusEmitter);
  }

  /** Event: a provider's diagnostics for a file were applied to the store. */
  readonly onProblemsChanged: Event<ProblemChangeEvent>;

  /** Event: running totals changed. */
  readonly onTotalsChanged: Event<TotalsChangedEvent>;

  /** Event: idle/scanning snapshot with running + queued counts. */
  readonly onScanStateChanged: Event<ScanStateEvent>;

  /** Event: a provider's health state changed. */
  readonly onProviderStatusChanged: Event<ProviderStatusChangeEvent>;

  /** Current summary for a file/folder, or the whole workspace when omitted. */
  getProblems(uri?: Uri): ProblemSummary {
    if (uri === undefined) {
      return this.store.getFolderSummary(this.workspaceRoot);
    }
    return this.store.getSummary(uri);
  }

  /** Running totals across the whole workspace. */
  getTotals(): ProblemTotals {
    return this.store.totals;
  }

  /** Providers that have written diagnostics for a path (union). */
  getOwners(uri: Uri): string[] {
    return this.store.getOwners(uri);
  }

  /**
   * Request a scan (§5.7). Manual jumps the queue; no uris = the whole
   * workspace. Resolves once the plans have been handed to the scheduler.
   */
  async scan(type: ScanType, uris?: readonly Uri[]): Promise<void> {
    this.analyzer.requestScan(uris, PRIORITY_BY_SCAN_TYPE[type]);
  }

  /** Debounced per-file save scan (§5.7). */
  scanOnSave(fileUri: Uri): void {
    let stats;
    try {
      stats = statSync(fileUri.fsPath);
    } catch {
      // Removed between the save and now — nothing left to scan.
      this.analyzer.onFileChanged(fileUri, undefined, undefined);
      return;
    }
    this.analyzer.onFileChanged(fileUri, stats.mtimeMs, stats.size);
  }

  /** Editor-pushed diagnostics for a file (e.g. from VS Code). Applied through the same store gate as scans.
   *  Ownership: when no scanner is (yet) Ready for the file's capability, the realtime provider takes
   *  ownership — its problems are the only ones the user can see. As soon as a scanning provider
   *  health-checks Ready and runs, ownership transfers per §9.3 and editor pushes become gated. */
  reportEditorDiagnostics(uri: Uri, diagnostics: readonly Diagnostic[]): void {
    const providerId = this.realtimeProviderId;
    if (providerId === undefined) {
      return;
    }
    const capability = extensionCapability(uri);
    const owner =
      capability !== undefined ? (this.bestOwnerFor(capability) ?? providerId) : providerId;
    this.store.setDiagnostics(providerId, uri, diagnostics);
    this.store.recordOwner(uri, owner);
  }

  /** Full rescan of the workspace; results treated as fresh (§7.2). */
  async rescanAll(): Promise<void> {
    this.cache.invalidateAll();
    this.analyzer.requestScan(
      this.index.listFiles().map((entry) => entry.uri),
      'manual',
    );
  }

  /** Shut down: unsubscribe everything, drop queued work, clear timers. */
  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.analyzer.dispose();
    this.scheduler.dispose();
    this.registry.dispose();
    this.providerStatusEmitter.clear();
    this.store.clear();
  }

  /** Exposed for testing/observability. */
  get runningCount(): number {
    return this.scheduler.runningCount;
  }

  get queuedCount(): number {
    return this.scheduler.queuedCount;
  }

  get rejectedWriteCount(): number {
    return this.store.rejectedWriteCount;
  }

  private handleFileChanges(changes: readonly FileChange[]): void {
    for (const change of changes) {
      if (change.kind === 'remove') {
        this.analyzer.onFileChanged(change.uri, undefined, undefined);
        continue;
      }
      this.analyzer.onFileChanged(change.uri, change.modifiedMs, change.size);
    }
  }

  private enqueuePlans(plans: readonly ScanPlan[]): void {
    for (const plan of plans) {
      this.scheduler.enqueue(plan);
    }
  }

  /** Store gate: writes land only when the provider owns the path (§5.2). */
  private applyResult(event: ScanJobCompleteEvent): void {
    // §9: ownership is computed — the best available provider for the job's
    // capability owns the scanned paths (tier desc, then registration order),
    // not necessarily the provider that happened to run this job.
    const owner = this.bestOwnerFor(event.job.capability);
    const reported = new Set((event.result.files ?? []).map((file) => normalizeUriKey(file.uri)));
    for (const file of event.result.files ?? []) {
      this.store.setDiagnostics(event.providerId, file.uri, file.diagnostics);
      this.store.recordOwner(file.uri, owner);
      this.cache.recordResult(file.uri, event.providerId);
      this.index.markScanned(file.uri, event.providerId);
    }
    // A file the job scanned but the tool did not report is clean now:
    // clear the previous findings so fixes actually disappear (§7.2).
    // A FAILED scan (tool error) proves nothing — keep prior findings.
    if ((event.result.errors?.length ?? 0) === 0) {
      for (const uri of event.job.uris ?? []) {
        if (!reported.has(normalizeUriKey(uri))) {
          this.store.setDiagnostics(event.providerId, uri, []);
          this.cache.recordResult(uri, event.providerId);
          this.index.markScanned(uri, event.providerId);
        }
      }
    }
  }

  private bestOwnerFor(capability: ConfigType): string | undefined {
    const best = this.registry.getByCapability(capability)[0];
    if (best === undefined || this.registry.getStatus(best.id)?.health !== ProviderHealth.Ready) {
      return undefined;
    }
    return best.id;
  }
}
