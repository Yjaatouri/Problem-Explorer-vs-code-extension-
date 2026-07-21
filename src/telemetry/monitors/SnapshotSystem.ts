import { Uri } from 'vscode';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { generateTraceId, now } from '../../telemetry/TelemetryConfig';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { TelemetryConfigManager } from '../../telemetry/TelemetryConfig';
import { StoreMonitor } from './StoreMonitor';
import { ProviderMonitor } from './ProviderMonitor';
import { AutoScannerMonitor } from './AutoScannerMonitor';
import { DiagnosticsMonitor } from './DiagnosticsMonitor';
import { FolderMonitor } from './FolderMonitor';
import { DecorationMonitor } from './DecorationMonitor';
import { EventPipelineMonitor } from './EventPipelineMonitor';
import { RuntimeAssertions } from './RuntimeAssertions';

/* ------------------------------------------------------------------ */
/*  Snapshot ID                                                        */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const SnapshotIdBrand: unique symbol;
export type SnapshotId = string & { readonly __brand: typeof SnapshotIdBrand };

export function generateSnapshotId(): SnapshotId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` as SnapshotId;
}

/* ------------------------------------------------------------------ */
/*  Snapshot Trigger                                                   */
/* ------------------------------------------------------------------ */

export enum SnapshotTrigger {
  Manual = 'manual',
  AssertionFailure = 'assertionFailure',
  PipelineFailure = 'pipelineFailure',
  ProviderFailure = 'providerFailure',
  FatalException = 'fatalException',
  Automatic = 'automatic',
  Periodic = 'periodic',
}

/* ------------------------------------------------------------------ */
/*  Snapshot Metadata                                                  */
/* ------------------------------------------------------------------ */

export interface SnapshotMetadata {
  readonly id: SnapshotId;
  readonly timestamp: number;
  readonly trigger: SnapshotTrigger;
  readonly pipelineId?: string;
  readonly uri?: string;
  readonly provider?: string;
  readonly ruleName?: string;
  readonly vscodeVersion: string;
  readonly extensionVersion: string;
  readonly workspaceFolders: readonly string[];
}

/* ------------------------------------------------------------------ */
/*  Snapshot data interfaces (existing + extended)                     */
/* ------------------------------------------------------------------ */

export interface StoreEntrySnapshot {
  readonly key: string;
  readonly severity: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly fileCount: number;
  readonly provider?: string;
}

export interface StoreSnapshot {
  readonly version: number;
  readonly entryCount: number;
  readonly folderAggregateCount: number;
  readonly fileEntryCount: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalInfos: number;
  readonly providerPriorities: Record<string, number>;
  readonly entries?: readonly StoreEntrySnapshot[];
  readonly folderAggregates?: readonly StoreEntrySnapshot[];
}

export interface FolderSnapshot {
  readonly trackedUris: number;
}

export interface ProviderSnapshotEntry {
  readonly state: string;
  readonly priority: number;
  readonly capabilities: readonly string[];
  readonly ownedExtensions: readonly string[];
}

export interface ProviderSnapshot {
  readonly count: number;
  readonly started: boolean;
  readonly entries: Record<string, ProviderSnapshotEntry>;
}

export interface OwnershipSnapshot {
  readonly providers: readonly string[];
  readonly extensionMap: Record<string, string>;
}

export interface ScanSnapshot {
  readonly active: number;
  readonly queued: number;
}

export interface TimerSnapshot {
  readonly active: number;
}

export interface ConfigSnapshot {
  readonly enabled: boolean;
  readonly bufferSize: number;
  readonly flushIntervalMs: number;
  readonly includeStackTraces: boolean;
}

/* ------------------------------------------------------------------ */
/*  Monitor state snapshots (captured from each monitor)               */
/* ------------------------------------------------------------------ */

export interface SnapshotMonitorState {
  store?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  autoScanner?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  decoration?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
  runtimeAssertions?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  SystemSnapshot — the core data payload                             */
/* ------------------------------------------------------------------ */

export interface SystemSnapshot {
  readonly timestamp: number;
  readonly store: StoreSnapshot;
  readonly folders: FolderSnapshot;
  readonly providers: ProviderSnapshot;
  readonly ownership: OwnershipSnapshot;
  readonly scans: ScanSnapshot;
  readonly timers: TimerSnapshot;
  readonly config: ConfigSnapshot;
  readonly monitors?: SnapshotMonitorState;
}

/* ------------------------------------------------------------------ */
/*  Snapshot — a captured snapshot with metadata                       */
/* ------------------------------------------------------------------ */

export interface Snapshot {
  readonly metadata: SnapshotMetadata;
  readonly data: SystemSnapshot;
  readonly sizeBytes: number;
}

/* ------------------------------------------------------------------ */
/*  Snapshot Statistics                                                */
/* ------------------------------------------------------------------ */

export interface SnapshotStatistics {
  readonly totalSnapshots: number;
  readonly totalManual: number;
  readonly totalAutomatic: number;
  readonly totalFailed: number;
  readonly averageCreationTimeMs: number;
  readonly peakCreationTimeMs: number;
  readonly totalSnapshotSizeBytes: number;
  readonly averageSnapshotSizeBytes: number;
  readonly snapshotsByTrigger: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/*  SnapshotSystem                                                     */
/* ------------------------------------------------------------------ */

export class SnapshotSystem {
  protected readonly snapshots = new Map<SnapshotId, Snapshot>();
  protected readonly maxSnapshots = 1000;
  protected readonly sub: TelemetrySubscription;
  protected readonly assertionSub: TelemetrySubscription;
  protected readonly pipelineFailureSub: TelemetrySubscription;
  protected readonly providerFailureSub: TelemetrySubscription;
  protected disposed = false;
  protected autoCaptureTimer?: ReturnType<typeof setInterval>;

  /* Runtime state tracked via events */
  protected activeScans = 0;
  protected queuedScans = 0;
  protected activeTimers = 0;

  /* Statistics counters */
  protected totalSnapshots = 0;
  protected totalManual = 0;
  protected totalAutomatic = 0;
  protected totalFailed = 0;
  protected totalCreationTimeMs = 0;
  protected peakCreationTimeMs = 0;
  protected totalSnapshotSizeBytes = 0;
  protected readonly snapshotsByTrigger = new Map<string, number>();

  private vscodeVersion = 'unknown';
  private extensionVersion = 'unknown';
  private workspaceFolders: readonly string[] = [];

  constructor(
    protected readonly reporter: TelemetryReporter,
    protected readonly problemStore?: ProblemStore,
    protected readonly dpm?: DiagnosticProviderManager,
    protected readonly configManager?: TelemetryConfigManager,
    protected readonly storeMonitor?: StoreMonitor,
    protected readonly providerMonitor?: ProviderMonitor,
    protected readonly autoScannerMonitor?: AutoScannerMonitor,
    protected readonly diagnosticsMonitor?: DiagnosticsMonitor,
    protected readonly folderMonitor?: FolderMonitor,
    protected readonly decorationMonitor?: DecorationMonitor,
    protected readonly pipelineMonitor?: EventPipelineMonitor,
    protected readonly runtimeAssertions?: RuntimeAssertions,
  ) {
    this.sub = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('snapshot.') || event.type.startsWith('perf.') || event.type.startsWith('pipeline.')) return;

      const data = event as any;

      if (event.type === 'provider.scan') {
        if (data.phase === 'begin') this.activeScans++;
        else if (data.phase === 'end' || data.phase === 'error' || data.phase === 'cancelled') this.activeScans = Math.max(0, this.activeScans - 1);
      }

      if (event.type === 'autoscan.queue') this.queuedScans++;
      else if (event.type === 'autoscan.flush') this.queuedScans = Math.max(0, this.queuedScans - (data.queueSize ?? 1));
      else if (event.type === 'autoscan.cancel') this.queuedScans = Math.max(0, this.queuedScans - 1);

      if (event.type === 'timer.setTimeout') this.activeTimers++;
      else if (event.type === 'timer.clearTimeout' || event.type === 'timer.executed') this.activeTimers = Math.max(0, this.activeTimers - 1);
    });

    this.assertionSub = reporter.subscribe('assertion.failure', () => {
      setTimeout(() => { if (!this.disposed) this.captureAndReport(SnapshotTrigger.AssertionFailure); }, 0);
    });

    this.pipelineFailureSub = reporter.subscribe('pipeline.execution.failed', () => {
      setTimeout(() => { if (!this.disposed) this.captureAndReport(SnapshotTrigger.PipelineFailure); }, 0);
    });

    this.providerFailureSub = reporter.subscribe('provider.error', () => {
      setTimeout(() => { if (!this.disposed) this.captureAndReport(SnapshotTrigger.ProviderFailure); }, 0);
    });
  }

  /** Trigger a manual snapshot — returns the captured Snapshot */
  captureManual(extra?: Partial<SnapshotMetadata>): Snapshot {
    return this.createSnapshot(SnapshotTrigger.Manual, extra);
  }

  /** Trigger a snapshot on fatal/unhandled exception */
  captureFatalException(error: Error, extra?: Partial<SnapshotMetadata>): Snapshot {
    return this.createSnapshot(SnapshotTrigger.FatalException, {
      ...extra,
      ruleName: extra?.ruleName ?? error.message,
    });
  }

  /** Enable periodic automatic snapshots at a given interval (ms). Pass 0 to disable. */
  setAutoCaptureInterval(intervalMs: number): void {
    if (this.autoCaptureTimer) {
      clearInterval(this.autoCaptureTimer);
      this.autoCaptureTimer = undefined;
    }
    if (intervalMs > 0) {
      this.autoCaptureTimer = setInterval(() => {
        if (this.disposed) return;
        this.captureAndReport(SnapshotTrigger.Periodic);
      }, intervalMs);
    }
  }

  setEnvironmentInfo(vscodeVersion: string, extensionVersion: string, workspaceFolders: readonly string[]): void {
    this.vscodeVersion = vscodeVersion;
    this.extensionVersion = extensionVersion;
    this.workspaceFolders = workspaceFolders;
  }

  createSnapshot(trigger: SnapshotTrigger, extra?: Partial<SnapshotMetadata>): Snapshot {
    const start = now();
    try {
      const id = generateSnapshotId();
      const data = this.captureSystemSnapshot();
      let sizeBytes = 0;
      try { sizeBytes = new TextEncoder().encode(JSON.stringify(data)).length; } catch { sizeBytes = JSON.stringify(data).length * 2; }

      const metadata: SnapshotMetadata = {
        id,
        timestamp: data.timestamp,
        trigger,
        pipelineId: extra?.pipelineId,
        uri: extra?.uri,
        provider: extra?.provider,
        ruleName: extra?.ruleName,
        vscodeVersion: this.vscodeVersion,
        extensionVersion: this.extensionVersion,
        workspaceFolders: this.workspaceFolders,
      };

      const snapshot: Snapshot = { metadata, data, sizeBytes };

      this.snapshots.set(id, snapshot);
      this.evictSnapshots();

      const elapsed = now() - start;
      this.totalSnapshots++;
      if (trigger === SnapshotTrigger.Manual) this.totalManual++;
      else this.totalAutomatic++;
      this.totalCreationTimeMs += elapsed;
      if (elapsed > this.peakCreationTimeMs) this.peakCreationTimeMs = elapsed;
      this.totalSnapshotSizeBytes += sizeBytes;
      const triggerKey = trigger as string;
      this.snapshotsByTrigger.set(triggerKey, (this.snapshotsByTrigger.get(triggerKey) ?? 0) + 1);

      return snapshot;
    } catch (e) {
      this.totalFailed++;
      throw e;
    }
  }

  private evictSnapshots(): void {
    while (this.snapshots.size > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.snapshots.get(oldest);
      this.snapshots.delete(oldest);
      if (removed) {
        this.totalSnapshotSizeBytes -= removed.sizeBytes;
      }
    }
  }

  getSnapshot(id: SnapshotId): Snapshot | undefined {
    return this.snapshots.get(id);
  }

  deleteSnapshot(id: SnapshotId): boolean {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return false;
    this.totalSnapshotSizeBytes = Math.max(0, this.totalSnapshotSizeBytes - snapshot.sizeBytes);
    return this.snapshots.delete(id);
  }

  listSnapshots(): readonly Snapshot[] {
    return [...this.snapshots.values()];
  }

  /** Serialize a snapshot to a JSON string for storage or export */
  static serializeSnapshot(snapshot: Snapshot, pretty?: boolean): string {
    return JSON.stringify(snapshot, null, pretty ? 2 : undefined);
  }

  /** Serialize an array of snapshots to a JSON string */
  static serializeSnapshots(snapshots: readonly Snapshot[], pretty?: boolean): string {
    return JSON.stringify(snapshots, null, pretty ? 2 : undefined);
  }

  /** Deserialize a single snapshot from a JSON string */
  static deserializeSnapshot(json: string): Snapshot {
    const parsed = JSON.parse(json);
    if (!parsed || !parsed.metadata || !parsed.data) {
      throw new Error('Invalid snapshot JSON: missing metadata or data');
    }
    const metadata = parsed.metadata as SnapshotMetadata;
    const data = parsed.data as SystemSnapshot;
    if (!metadata.id || !metadata.timestamp || !metadata.trigger) {
      throw new Error('Invalid snapshot JSON: metadata missing required fields');
    }
    return { metadata, data } as Snapshot;
  }

  /** Deserialize an array of snapshots from a JSON string */
  static deserializeSnapshots(json: string): Snapshot[] {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid snapshots JSON: expected an array');
    }
    return parsed.map((item: unknown) => {
      const obj = item as any;
      if (!obj?.metadata || !obj?.data) {
        throw new Error('Invalid snapshot entry in array: missing metadata or data');
      }
      return { metadata: obj.metadata as SnapshotMetadata, data: obj.data as SystemSnapshot } as Snapshot;
    });
  }

  /** Export all stored snapshots as a JSON string */
  exportAllSnapshots(pretty?: boolean): string {
    return SnapshotSystem.serializeSnapshots(this.listSnapshots(), pretty);
  }

  /** Import snapshots from a JSON string and add them to the store */
  importSnapshots(json: string): number {
    const snapshots = SnapshotSystem.deserializeSnapshots(json);
    let imported = 0;
    for (const snapshot of snapshots) {
      if (!this.snapshots.has(snapshot.metadata.id)) {
        const entry = { ...snapshot, sizeBytes: snapshot.sizeBytes ?? 0 };
        if (entry.sizeBytes === 0) {
          try { entry.sizeBytes = new TextEncoder().encode(JSON.stringify(entry.data)).length; } catch { entry.sizeBytes = JSON.stringify(entry.data).length * 2; }
        }
        this.snapshots.set(entry.metadata.id as SnapshotId, entry);
        imported++;
        this.totalSnapshots++;
        const triggerKey = entry.metadata.trigger as string;
        this.snapshotsByTrigger.set(triggerKey, (this.snapshotsByTrigger.get(triggerKey) ?? 0) + 1);
        if (entry.metadata.trigger === SnapshotTrigger.Manual) this.totalManual++;
        if (entry.metadata.trigger === SnapshotTrigger.Automatic) this.totalAutomatic++;
        this.totalSnapshotSizeBytes += entry.sizeBytes;
      }
    }
    if (imported > 0) this.evictSnapshots();
    return imported;
  }

  getStatistics(): SnapshotStatistics {
    return {
      totalSnapshots: this.totalSnapshots,
      totalManual: this.totalManual,
      totalAutomatic: this.totalAutomatic,
      totalFailed: this.totalFailed,
      averageCreationTimeMs: this.totalSnapshots > 0 ? Math.round(this.totalCreationTimeMs / this.totalSnapshots) : 0,
      peakCreationTimeMs: this.peakCreationTimeMs,
      totalSnapshotSizeBytes: this.totalSnapshotSizeBytes,
      averageSnapshotSizeBytes: this.totalSnapshots > 0 ? Math.round(this.totalSnapshotSizeBytes / this.totalSnapshots) : 0,
      snapshotsByTrigger: Object.fromEntries(this.snapshotsByTrigger),
    };
  }

  captureSystemSnapshot(): SystemSnapshot {
    const timestamp = now();
    const monitors = this.captureMonitors();
    return {
      timestamp,
      store: this.captureStore(),
      folders: this.captureFolders(monitors),
      providers: this.captureProviders(),
      ownership: this.captureOwnership(),
      scans: { active: this.activeScans, queued: this.queuedScans },
      timers: { active: this.activeTimers },
      config: this.captureConfig(),
      monitors,
    };
  }

  private captureMonitors(): SnapshotMonitorState | undefined {
    const monitors: SnapshotMonitorState = {};
    if (this.providerMonitor) {
      try { monitors.provider = { snapshots: this.providerMonitor.getAllSnapshots() }; } catch { /* skip */ }
    }
    if (this.autoScannerMonitor) {
      try { monitors.autoScanner = this.autoScannerMonitor.getSnapshot() as any; } catch { /* skip */ }
    }
    if (this.diagnosticsMonitor) {
      try { monitors.diagnostics = this.diagnosticsMonitor.captureSnapshot() as any; } catch { /* skip */ }
    }
    if (this.folderMonitor) {
      try { monitors.folder = this.folderMonitor.captureSnapshot() as any; } catch { /* skip */ }
    }
    if (this.decorationMonitor) {
      try { monitors.decoration = this.decorationMonitor.captureSnapshot() as any; } catch { /* skip */ }
    }
    if (this.pipelineMonitor) {
      try { monitors.pipeline = this.pipelineMonitor.captureSnapshot() as any; } catch { /* skip */ }
    }
    if (this.runtimeAssertions) {
      try {
        monitors.runtimeAssertions = {
          statistics: this.runtimeAssertions.engine.getStatistics(),
          failures: this.runtimeAssertions.engine.getFailures().slice(0, 50),
        };
      } catch { /* skip */ }
    }
    if (Object.keys(monitors).length === 0) return undefined;
    return monitors;
  }

  private captureStore(): StoreSnapshot {
    if (!this.problemStore) {
      return { version: 0, entryCount: 0, folderAggregateCount: 0, fileEntryCount: 0, totalErrors: 0, totalWarnings: 0, totalInfos: 0, providerPriorities: {} };
    }

    const totals = this.problemStore.computeTotals();
    let folderCount = 0;
    let fileCount = 0;
    const entries: StoreEntrySnapshot[] = [];
    const folderAggregates: StoreEntrySnapshot[] = [];

    this.problemStore.forEachEntry((key: string, state: import('../../core/types').ProblemState, isFolder: boolean) => {
      if (isFolder) {
        folderCount++;
        if (folderAggregates.length < 500) {
          folderAggregates.push({
            key, severity: state.severity,
            errorCount: state.errorCount, warningCount: state.warningCount,
            infoCount: state.infoCount, fileCount: state.fileCount,
            provider: this.problemStore?.getOwningProvider(Uri.parse(key)),
          });
        }
      } else {
        fileCount++;
        if (entries.length < 500) {
          entries.push({
            key, severity: state.severity,
            errorCount: state.errorCount, warningCount: state.warningCount,
            infoCount: state.infoCount, fileCount: state.fileCount,
            provider: this.problemStore?.getOwningProvider(Uri.parse(key)),
          });
        }
      }
    });

    const providerPriorities: Record<string, number> = {};
    if (this.dpm) {
      for (const info of this.dpm.all()) {
        providerPriorities[info.name] = (info.metadata as any)?.priority ?? -1;
      }
    }

    return {
      version: this.problemStore.getVersion(),
      entryCount: this.problemStore.size(),
      folderAggregateCount: folderCount,
      fileEntryCount: fileCount,
      totalErrors: totals.errorCount,
      totalWarnings: totals.warningCount,
      totalInfos: totals.infoCount,
      providerPriorities,
      entries,
      folderAggregates,
    };
  }

  private captureFolders(monitors?: SnapshotMonitorState): FolderSnapshot {
    let trackedUris = 0;
    if (monitors?.folder) {
      const folderData = monitors.folder as Record<string, unknown>;
      trackedUris = (folderData.indexSize as number) ?? 0;
    } else if (this.folderMonitor) {
      try {
        const snap = this.folderMonitor.captureSnapshot();
        trackedUris = snap.indexSize;
      } catch { /* skip */ }
    }
    return { trackedUris };
  }

  private captureProviders(): ProviderSnapshot {
    if (!this.dpm) {
      return { count: 0, started: false, entries: {} };
    }

    const all = this.dpm.all();
    const entries: Record<string, ProviderSnapshotEntry> = {};
    for (const info of all) {
      entries[info.name] = {
        state: info.state,
        priority: (info.metadata as any)?.priority ?? -1,
        capabilities: (info.metadata as any)?.capabilities ?? [],
        ownedExtensions: this.dpm.getOwnedExtensions(info.name),
      };
    }
    return { count: all.length, started: this.dpm.started, entries };
  }

  private captureOwnership(): OwnershipSnapshot {
    if (!this.dpm) {
      return { providers: [], extensionMap: {} };
    }

    const all = this.dpm.all();
    const providers = all.map((i) => i.name);
    const extensionMap: Record<string, string> = {};
    for (const name of providers) {
      const exts = this.dpm.getOwnedExtensions(name);
      for (const ext of exts) {
        extensionMap[ext] = name;
      }
    }
    return { providers, extensionMap };
  }

  private captureConfig(): ConfigSnapshot {
    if (!this.configManager) {
      return { enabled: false, bufferSize: 0, flushIntervalMs: 0, includeStackTraces: false };
    }
    const cfg = this.configManager.getConfig();
    return {
      enabled: cfg.enabled,
      bufferSize: cfg.bufferSize,
      flushIntervalMs: cfg.flushIntervalMs,
      includeStackTraces: cfg.includeStackTraces,
    };
  }

  captureAndReport(trigger?: SnapshotTrigger, extra?: Partial<SnapshotMetadata>): Snapshot {
    const snapshot = this.createSnapshot(trigger ?? SnapshotTrigger.Automatic, extra);
    this.reporter.report({
      type: 'snapshot.capture',
      timestamp: snapshot.metadata.timestamp,
      traceId: generateTraceId(),
      source: 'SnapshotSystem',
      snapshotId: snapshot.metadata.id,
      trigger: snapshot.metadata.trigger,
      store: snapshot.data.store,
      folders: snapshot.data.folders,
      providers: snapshot.data.providers,
      ownership: snapshot.data.ownership,
      scans: snapshot.data.scans,
      timers: snapshot.data.timers,
      config: snapshot.data.config,
      monitors: snapshot.data.monitors,
    } as any);
    return snapshot;
  }

  generateForensicReport(): string {
    const s = this.captureSystemSnapshot();
    const lines: string[] = [];

    lines.push(`[SNAPSHOT:REPORT] ===== SYSTEM SNAPSHOT =====`);
    lines.push(`[SNAPSHOT:REPORT] Timestamp: ${new Date(s.timestamp).toISOString()}`);
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Store --`);
    lines.push(`[SNAPSHOT:REPORT]   Version:             ${s.store.version}`);
    lines.push(`[SNAPSHOT:REPORT]   Total entries:       ${s.store.entryCount}`);
    lines.push(`[SNAPSHOT:REPORT]   File entries:        ${s.store.fileEntryCount}`);
    lines.push(`[SNAPSHOT:REPORT]   Folder aggregates:   ${s.store.folderAggregateCount}`);
    lines.push(`[SNAPSHOT:REPORT]   Errors: ${s.store.totalErrors}   Warnings: ${s.store.totalWarnings}   Infos: ${s.store.totalInfos}`);
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Providers --`);
    lines.push(`[SNAPSHOT:REPORT]   Count:   ${s.providers.count}`);
    lines.push(`[SNAPSHOT:REPORT]   Started: ${s.providers.started}`);
    for (const [name, p] of Object.entries(s.providers.entries)) {
      const caps = p.capabilities.join(', ');
      lines.push(`[SNAPSHOT:REPORT]   ${name}: state=${p.state}, priority=${p.priority}, capabilities=[${caps}]`);
    }
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Ownership --`);
    lines.push(`[SNAPSHOT:REPORT]   Providers: ${s.ownership.providers.join(', ')}`);
    for (const [ext, owner] of Object.entries(s.ownership.extensionMap)) {
      lines.push(`[SNAPSHOT:REPORT]   ${ext} -> ${owner}`);
    }
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Scans --`);
    lines.push(`[SNAPSHOT:REPORT]   Active: ${s.scans.active}`);
    lines.push(`[SNAPSHOT:REPORT]   Queued: ${s.scans.queued}`);
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Timers --`);
    lines.push(`[SNAPSHOT:REPORT]   Active: ${s.timers.active}`);
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Config --`);
    lines.push(`[SNAPSHOT:REPORT]   Telemetry enabled:       ${s.config.enabled}`);
    lines.push(`[SNAPSHOT:REPORT]   Buffer size:             ${s.config.bufferSize}`);
    lines.push(`[SNAPSHOT:REPORT]   Flush interval (ms):     ${s.config.flushIntervalMs}`);
    lines.push(`[SNAPSHOT:REPORT]   Include stack traces:    ${s.config.includeStackTraces}`);
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] -- Monitors --`);
    if (s.monitors) {
      const activeMonitors = Object.keys(s.monitors).filter((k) => s.monitors![k as keyof SnapshotMonitorState] !== undefined);
      lines.push(`[SNAPSHOT:REPORT]   Active monitors: ${activeMonitors.join(', ') || 'none'}`);
    } else {
      lines.push(`[SNAPSHOT:REPORT]   No monitor references available`);
    }
    lines.push(``);
    lines.push(`[SNAPSHOT:REPORT] ===== END SYSTEM SNAPSHOT =====`);
    return lines.join('\n');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sub.dispose();
    this.assertionSub.dispose();
    this.pipelineFailureSub.dispose();
    this.providerFailureSub.dispose();
    if (this.autoCaptureTimer) {
      clearInterval(this.autoCaptureTimer);
      this.autoCaptureTimer = undefined;
    }
    this.snapshots.clear();
  }
}

/** Create a SnapshotSystem attached to the given reporter and optional business object references */
export function createSnapshotSystem(
  reporter: TelemetryReporter,
  problemStore?: ProblemStore,
  dpm?: DiagnosticProviderManager,
  configManager?: TelemetryConfigManager,
  storeMonitor?: StoreMonitor,
  providerMonitor?: ProviderMonitor,
  autoScannerMonitor?: AutoScannerMonitor,
  diagnosticsMonitor?: DiagnosticsMonitor,
  folderMonitor?: FolderMonitor,
  decorationMonitor?: DecorationMonitor,
  pipelineMonitor?: EventPipelineMonitor,
  runtimeAssertions?: RuntimeAssertions,
): SnapshotSystem {
  return new SnapshotSystem(reporter, problemStore, dpm, configManager, storeMonitor, providerMonitor, autoScannerMonitor, diagnosticsMonitor, folderMonitor, decorationMonitor, pipelineMonitor, runtimeAssertions);
}
