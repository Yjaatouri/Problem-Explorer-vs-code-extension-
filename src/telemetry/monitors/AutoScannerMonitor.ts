import { Disposable, Uri, workspace, TextDocument } from 'vscode';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { ScanProgress } from '../../core/types';
import { TelemetryReporter } from '../../telemetry';
import { generateTraceId } from '../../telemetry';

/** Structured event payload for a file-save trigger */
export interface AutoScanFileSavedEventData {
  readonly type: 'autoscan.fileSaved';
  readonly uri: string;
  readonly provider: string;
  readonly extension: string;
  readonly queueSize: number;
}

/** Structured event payload for queue state */
export interface AutoScanQueueEventData {
  readonly type: 'autoscan.queue';
  readonly provider: string;
  readonly queueSize: number;
  readonly queuedProviders: readonly string[];
}

/** Structured event payload for flush begin */
export interface AutoScanFlushEventData {
  readonly type: 'autoscan.flush';
  readonly providerNames: readonly string[];
  readonly queueSize: number;
  readonly debounceDelay: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for a single provider execution during flush */
export interface AutoScanProviderExecutionEventData {
  readonly type: 'autoscan.providerExecution';
  readonly provider: string;
  readonly scanPhase: string;
  readonly executionTimeMs: number;
}

/** Structured event payload for flush completion */
export interface AutoScanFlushCompleteEventData {
  readonly type: 'autoscan.flushComplete';
  readonly providerCount: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for a cancelled scan */
export interface AutoScanCancelEventData {
  readonly type: 'autoscan.cancel';
  readonly provider: string;
  readonly executionTimeMs: number;
  readonly error?: string;
}

/** Union of all auto-scanner monitor event types */
export type AutoScannerMonitorEvent =
  | AutoScanFileSavedEventData
  | AutoScanQueueEventData
  | AutoScanFlushEventData
  | AutoScanProviderExecutionEventData
  | AutoScanFlushCompleteEventData
  | AutoScanCancelEventData;

/** Monitors AutoScanController activity via external observation */
export class AutoScannerMonitor implements Disposable {
  private readonly queuedProviders = new Set<string>();
  private readonly providerTimestamps = new Map<string, number>();
  private readonly flushProviders = new Set<string>();
  private activeScans = 0;
  private flushStartTime = 0;
  private firstFileEventTime = 0;
  private disposed = false;
  private readonly disposables: Disposable[] = [];

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly reporter: TelemetryReporter
  ) {
    this.subscribeToFileEvents();
    this.manager.onDidScanProgress((progress: ScanProgress) => {
      if (this.disposed) return;
      this.handleScanProgress(progress);
    });
  }

  private subscribeToFileEvents(): void {
    this.disposables.push(
      workspace.onDidSaveTextDocument((doc: TextDocument) => {
        if (this.disposed) return;
        this.handleFileEvent(doc.uri);
      }),
      workspace.onDidCreateFiles((e) => {
        if (this.disposed) return;
        for (const uri of e.files) {
          this.handleFileEvent(uri);
        }
      }),
      workspace.onDidDeleteFiles((e) => {
        if (this.disposed) return;
        for (const uri of e.files) {
          this.handleFileEvent(uri);
        }
      }),
      workspace.onDidRenameFiles((e) => {
        if (this.disposed) return;
        for (const { newUri } of e.files) {
          this.handleFileEvent(newUri);
        }
      }),
    );
  }

  private handleFileEvent(uri: Uri): void {
    const ext = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));
    const ownerName = this.manager.getOwner(ext);
    if (!ownerName) return;

    const now = Date.now();
    if (this.firstFileEventTime === 0) {
      this.firstFileEventTime = now;
    }

    this.reporter.report({
      type: 'autoscan.fileSaved',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'AutoScannerMonitor',
      uri: uri.toString(),
      provider: ownerName,
      extension: ext,
      queueSize: this.queuedProviders.size,
    } as any);

    if (!this.queuedProviders.has(ownerName)) {
      this.queuedProviders.add(ownerName);
      this.reporter.report({
        type: 'autoscan.queue',
        timestamp: now,
        traceId: generateTraceId(),
        source: 'AutoScannerMonitor',
        provider: ownerName,
        queueSize: this.queuedProviders.size,
        queuedProviders: Array.from(this.queuedProviders),
      } as any);
    }
  }

  private handleScanProgress(progress: ScanProgress): void {
    const now = Date.now();
    const traceId = generateTraceId();

    switch (progress.phase) {
      case 'resolving':
      case 'scanning':
      case 'parsing':
      case 'writing': {
        const isFirstScan = this.activeScans === 0;

        if (isFirstScan && this.queuedProviders.size > 0) {
          this.flushStartTime = now;
          const debounceDelay = now - this.firstFileEventTime;
          this.flushProviders.clear();
          for (const p of this.queuedProviders) {
            this.flushProviders.add(p);
          }

          this.reporter.report({
            type: 'autoscan.flush',
            timestamp: now,
            traceId,
            source: 'AutoScannerMonitor',
            providerNames: Array.from(this.queuedProviders),
            queueSize: this.queuedProviders.size,
            debounceDelay,
            executionTimeMs: 0,
          } as any);
        }

        const isNewProvider = !this.providerTimestamps.has(progress.providerName);
        if (isNewProvider) {
          this.providerTimestamps.set(progress.providerName, now);
          this.activeScans++;
        }

        this.reporter.report({
          type: 'autoscan.providerExecution',
          timestamp: now,
          traceId,
          source: 'AutoScannerMonitor',
          provider: progress.providerName,
          scanPhase: progress.phase,
          executionTimeMs: isNewProvider ? 0 : now - (this.providerTimestamps.get(progress.providerName) ?? now),
        } as any);
        break;
      }

      case 'completed': {
        const execTime = now - (this.providerTimestamps.get(progress.providerName) ?? now);
        this.providerTimestamps.delete(progress.providerName);
        this.activeScans = Math.max(0, this.activeScans - 1);

        this.reporter.report({
          type: 'autoscan.providerExecution',
          timestamp: now,
          traceId,
          source: 'AutoScannerMonitor',
          provider: progress.providerName,
          scanPhase: 'completed',
          executionTimeMs: execTime,
        } as any);

        if (this.activeScans === 0 && this.queuedProviders.size > 0) {
          this.emitFlushComplete(now);
        }
        break;
      }

      case 'cancelled': {
        const execTime = now - (this.providerTimestamps.get(progress.providerName) ?? now);
        this.providerTimestamps.delete(progress.providerName);
        this.activeScans = Math.max(0, this.activeScans - 1);

        this.reporter.report({
          type: 'autoscan.cancel',
          timestamp: now,
          traceId,
          source: 'AutoScannerMonitor',
          provider: progress.providerName,
          executionTimeMs: execTime,
        } as any);

        if (this.activeScans === 0 && this.queuedProviders.size > 0) {
          this.emitFlushComplete(now);
        }
        break;
      }

      case 'error': {
        const execTime = now - (this.providerTimestamps.get(progress.providerName) ?? now);
        this.providerTimestamps.delete(progress.providerName);
        this.activeScans = Math.max(0, this.activeScans - 1);

        this.reporter.report({
          type: 'autoscan.cancel',
          timestamp: now,
          traceId,
          source: 'AutoScannerMonitor',
          provider: progress.providerName,
          executionTimeMs: execTime,
          error: progress.detail ?? progress.message ?? 'Unknown scan error',
        } as any);

        if (this.activeScans === 0 && this.queuedProviders.size > 0) {
          this.emitFlushComplete(now);
        }
        break;
      }
    }
  }

  private emitFlushComplete(now: number): void {
    const providerCount = this.flushProviders.size;
    for (const p of this.flushProviders) {
      this.queuedProviders.delete(p);
    }
    this.flushProviders.clear();
    if (this.queuedProviders.size === 0) {
      this.firstFileEventTime = 0;
    }

    this.reporter.report({
      type: 'autoscan.flushComplete',
      timestamp: now,
      traceId: generateTraceId(),
      source: 'AutoScannerMonitor',
      providerCount,
      executionTimeMs: now - this.flushStartTime,
    } as any);
  }

  dispose(): void {
    this.disposed = true;
    this.queuedProviders.clear();
    this.flushProviders.clear();
    this.providerTimestamps.clear();
    this.activeScans = 0;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Create an AutoScannerMonitor attached to the given manager and reporter */
export function createAutoScannerMonitor(
  manager: DiagnosticProviderManager,
  reporter: TelemetryReporter
): AutoScannerMonitor {
  return new AutoScannerMonitor(manager, reporter);
}