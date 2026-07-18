import { Disposable, languages, DiagnosticChangeEvent, Uri } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { TelemetryReporter } from '../../telemetry';
import { generateTraceId } from '../../telemetry';

/** Structured event payload for a raw VS Code diagnostics change */
export interface DiagnosticsChangeEventData {
  readonly type: 'diagnostics.change';
  readonly uriCount: number;
}

/** Structured event payload for per-URI diagnostic processing (updateUri) */
export interface DiagnosticsUpdateUriEventData {
  readonly type: 'diagnostics.updateUri';
  readonly uri: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly totalCount: number;
}

/** Structured event payload for a full scan batch */
export interface DiagnosticsFullScanEventData {
  readonly type: 'diagnostics.fullScan';
  readonly uriCount: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalInfos: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for a flushUpdates trigger */
export interface DiagnosticsFlushUpdatesEventData {
  readonly type: 'diagnostics.flushUpdates';
  readonly uriCount: number;
  readonly executionTimeMs: number;
}

/** Union of all diagnostics monitor event types */
export type DiagnosticsMonitorEvent =
  | DiagnosticsChangeEventData
  | DiagnosticsUpdateUriEventData
  | DiagnosticsFullScanEventData
  | DiagnosticsFlushUpdatesEventData;

/** Monitors VS Code diagnostics pipeline: change events, per-URI processing, full scans, and flushUpdates */
export class DiagnosticsMonitor implements Disposable {
  private vsDiagProvider: DiagnosticProvider | undefined;
  private readonly providerTimestamps = new Map<string, number>();
  private readonly pendingScans = new Map<string, boolean>();
  private disposed = false;
  private readonly disposables: Disposable[] = [];

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly reporter: TelemetryReporter
  ) {
    this.disposables.push(
      languages.onDidChangeDiagnostics((e: DiagnosticChangeEvent) => {
        if (this.disposed) return;
        this.handleChangeEvent(e);
      })
    );

    const existing = this.manager.get('vscodeDiagnostics');
    if (existing) {
      this.attachToProvider(existing);
    }

    this.manager.onDidRegister((info) => {
      if (this.disposed) return;
      if (info.name === 'vscodeDiagnostics' && !this.vsDiagProvider) {
        this.attachToProvider(info.provider);
      }
    });

    this.manager.onDidScanProgress((progress) => {
      if (this.disposed) return;
      if (progress.providerName === 'vscodeDiagnostics') {
        if (progress.phase === 'scanning' || progress.phase === 'resolving') {
          this.pendingScans.set(progress.providerName, true);
        } else if (progress.phase === 'completed' || progress.phase === 'cancelled' || progress.phase === 'error') {
          this.pendingScans.delete(progress.providerName);
        }
      }
    });

    this.manager.onDidUpdateAll((uris) => {
      if (this.disposed) return;
      this.handleFlushUpdates(uris);
    });
  }

  private attachToProvider(provider: DiagnosticProvider): void {
    this.vsDiagProvider = provider;
    provider.onDidUpdate((uris) => {
      if (this.disposed) return;
      this.handleProviderUpdate(provider, uris);
    });
  }

  private handleChangeEvent(e: DiagnosticChangeEvent): void {
    this.reporter.report({
      type: 'diagnostics.change',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'DiagnosticsMonitor',
      uriCount: e.uris.length,
    } as any);
  }

  private handleProviderUpdate(provider: DiagnosticProvider, uris: Uri[]): void {
    const now = Date.now();
    const traceId = generateTraceId();
    const isFullScan = this.pendingScans.has(provider.name) || uris.length > 20;
    this.pendingScans.delete(provider.name);

    let totalErrors = 0;
    let totalWarnings = 0;
    let totalInfos = 0;

    for (const uri of uris) {
      const state = provider.store.get(uri);
      const errors = state?.errorCount ?? 0;
      const warnings = state?.warningCount ?? 0;
      const infos = state?.infoCount ?? 0;
      totalErrors += errors;
      totalWarnings += warnings;
      totalInfos += infos;

      this.reporter.report({
        type: 'diagnostics.updateUri',
        timestamp: now,
        traceId,
        source: 'DiagnosticsMonitor',
        uri: uri.toString(),
        errorCount: errors,
        warningCount: warnings,
        infoCount: infos,
        totalCount: errors + warnings + infos,
      } as any);
    }

    if (isFullScan) {
      const elapsed = now - (this.providerTimestamps.get(provider.name) ?? now);
      this.reporter.report({
        type: 'diagnostics.fullScan',
        timestamp: now,
        traceId,
        source: 'DiagnosticsMonitor',
        uriCount: uris.length,
        totalErrors,
        totalWarnings,
        totalInfos,
        executionTimeMs: elapsed,
      } as any);
      this.providerTimestamps.delete(provider.name);
    }

    this.providerTimestamps.set(provider.name, now);
  }

  private handleFlushUpdates(uris: Uri[]): void {
    const now = Date.now();
    const elapsed = now - (this.providerTimestamps.get('flushUpdates') ?? now);
    this.providerTimestamps.set('flushUpdates', now);

    this.reporter.report({
      type: 'diagnostics.flushUpdates',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'DiagnosticsMonitor',
      uriCount: uris.length,
      executionTimeMs: elapsed,
    } as any);
  }

  dispose(): void {
    this.disposed = true;
    this.vsDiagProvider = undefined;
    this.providerTimestamps.clear();
    this.pendingScans.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Create a DiagnosticsMonitor attached to the given manager and reporter */
export function createDiagnosticsMonitor(
  manager: DiagnosticProviderManager,
  reporter: TelemetryReporter
): DiagnosticsMonitor {
  return new DiagnosticsMonitor(manager, reporter);
}