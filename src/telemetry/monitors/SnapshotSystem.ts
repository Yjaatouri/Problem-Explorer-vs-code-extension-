import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { generateTraceId, now } from '../../telemetry/TelemetryConfig';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { TelemetryConfigManager } from '../../telemetry/TelemetryConfig';

/* ------------------------------------------------------------------ */
/*  Snapshot data interfaces                                           */
/* ------------------------------------------------------------------ */

export interface StoreSnapshot {
  readonly version: number;
  readonly entryCount: number;
  readonly folderAggregateCount: number;
  readonly fileEntryCount: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalInfos: number;
  readonly providerPriorities: Record<string, number>;
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

export interface SystemSnapshot {
  readonly timestamp: number;
  readonly store: StoreSnapshot;
  readonly folders: FolderSnapshot;
  readonly providers: ProviderSnapshot;
  readonly ownership: OwnershipSnapshot;
  readonly scans: ScanSnapshot;
  readonly timers: TimerSnapshot;
  readonly config: ConfigSnapshot;
}

/* ------------------------------------------------------------------ */
/*  SnapshotSystem                                                     */
/* ------------------------------------------------------------------ */

export class SnapshotSystem {
  private readonly sub: TelemetrySubscription;
  private readonly assertionSub: TelemetrySubscription;
  private disposed = false;

  /* Runtime state tracked via events */
  private activeScans = 0;
  private queuedScans = 0;
  private activeTimers = 0;

  constructor(
    private readonly reporter: TelemetryReporter,
    private readonly problemStore?: ProblemStore,
    private readonly dpm?: DiagnosticProviderManager,
    private readonly configManager?: TelemetryConfigManager,
  ) {
    this.sub = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      if (event.type.startsWith('snapshot.') || event.type.startsWith('perf.') || event.type.startsWith('pipeline.')) return;

      const data = event as any;

      /* Track active scans */
      if (event.type === 'provider.scan') {
        if (data.phase === 'begin') this.activeScans++;
        else if (data.phase === 'end' || data.phase === 'error' || data.phase === 'cancelled') this.activeScans = Math.max(0, this.activeScans - 1);
      }

      /* Track queued scans */
      if (event.type === 'autoscan.queue') this.queuedScans++;
      else if (event.type === 'autoscan.flush' || event.type === 'autoscan.cancel') this.queuedScans = Math.max(0, this.queuedScans - 1);

      /* Track active timers */
      if (event.type === 'timer.setTimeout') this.activeTimers++;
      else if (event.type === 'timer.clearTimeout' || event.type === 'timer.executed') this.activeTimers = Math.max(0, this.activeTimers - 1);
    });

    /* Auto-snapshot on assertion failure */
    this.assertionSub = reporter.subscribe('assertion.failure', () => {
      this.captureAndReport();
    });
  }

  /** Capture a full-system snapshot by querying available business objects and tracked event state */
  captureSnapshot(): SystemSnapshot {
    const timestamp = now();

    return {
      timestamp,
      store: this.captureStore(),
      folders: this.captureFolders(),
      providers: this.captureProviders(),
      ownership: this.captureOwnership(),
      scans: { active: this.activeScans, queued: this.queuedScans },
      timers: { active: this.activeTimers },
      config: this.captureConfig(),
    };
  }

  private captureStore(): StoreSnapshot {
    if (!this.problemStore) {
      return { version: 0, entryCount: 0, folderAggregateCount: 0, fileEntryCount: 0, totalErrors: 0, totalWarnings: 0, totalInfos: 0, providerPriorities: {} };
    }

    const totals = this.problemStore.computeTotals();
    let folderCount = 0;
    let fileCount = 0;
    this.problemStore.forEachEntry((_key: string, _state: import('../../core/types').ProblemState, isFolder: boolean) => {
      if (isFolder) folderCount++; else fileCount++;
    });

    return {
      version: this.problemStore.getVersion(),
      entryCount: this.problemStore.size(),
      folderAggregateCount: folderCount,
      fileEntryCount: fileCount,
      totalErrors: totals.errorCount,
      totalWarnings: totals.warningCount,
      totalInfos: totals.infoCount,
      providerPriorities: {},
    };
  }

  private captureFolders(): FolderSnapshot {
    return { trackedUris: 0 };
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

  /** Capture and report snapshot as a telemetry event with full payload */
  captureAndReport(): void {
    const snapshot = this.captureSnapshot();
    this.reporter.report({
      type: 'snapshot.capture',
      timestamp: snapshot.timestamp,
      traceId: generateTraceId(),
      source: 'SnapshotSystem',
      store: snapshot.store,
      folders: snapshot.folders,
      providers: snapshot.providers,
      ownership: snapshot.ownership,
      scans: snapshot.scans,
      timers: snapshot.timers,
      config: snapshot.config,
    } as any);
  }

  /** Generate a human-readable forensic snapshot report */
  generateForensicReport(): string {
    const s = this.captureSnapshot();
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
    lines.push(`[SNAPSHOT:REPORT] ===== END SYSTEM SNAPSHOT =====`);
    return lines.join('\n');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sub.dispose();
    this.assertionSub.dispose();
  }
}

/** Create a SnapshotSystem attached to the given reporter and optional business object references */
export function createSnapshotSystem(
  reporter: TelemetryReporter,
  problemStore?: ProblemStore,
  dpm?: DiagnosticProviderManager,
  configManager?: TelemetryConfigManager,
): SnapshotSystem {
  return new SnapshotSystem(reporter, problemStore, dpm, configManager);
}