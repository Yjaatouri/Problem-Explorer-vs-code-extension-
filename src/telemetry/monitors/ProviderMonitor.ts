import { DiagnosticProviderManager, ProviderState } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ScanProgress } from '../../core/types';
import { TelemetryReporter } from '../../telemetry';
import { generateTraceId } from '../../telemetry';

/** Structured event payload for provider lifecycle events: initialize, start, stop, dispose */
export interface ProviderLifecycleEventData {
  readonly type: 'provider.lifecycle';
  readonly provider: string;
  readonly phase: 'initialize' | 'start' | 'stop' | 'dispose';
  readonly oldState: ProviderState | undefined;
  readonly newState: ProviderState;
  readonly executionTimeMs: number;
  readonly success: boolean;
  readonly error?: string;
}

/** Structured event payload for provider scan events: begin, end, cancelled, error */
export interface ProviderScanEventData {
  readonly type: 'provider.scan';
  readonly provider: string;
  readonly phase: 'begin' | 'end' | 'cancelled' | 'error';
  readonly scanPhase: string;
  readonly executionTimeMs: number;
  readonly uriCount?: number;
  readonly diagnosticSummary?: { errors: number; warnings: number; infos: number };
  readonly message?: string;
  readonly error?: string;
}

/** Structured event payload for provider registry events: registered, unregistered */
export interface ProviderRegistryEventData {
  readonly type: 'provider.registry';
  readonly provider: string;
  readonly action: 'registered' | 'unregistered';
  readonly capabilities?: readonly string[];
  readonly priority?: number;
}

/** Union of all provider monitor event types */
export type ProviderMonitorEvent =
  | ProviderLifecycleEventData
  | ProviderScanEventData
  | ProviderRegistryEventData;

/** Monitors DiagnosticProvider lifecycle and scan operations */
export class ProviderMonitor {
  private readonly stateTimestamps = new Map<string, number>();
  private readonly scanTimestamps = new Map<string, number>();
  private readonly scanning = new Map<string, boolean>();
  private disposed = false;

  constructor(
    private readonly manager: DiagnosticProviderManager,
    private readonly reporter: TelemetryReporter
  ) {
    for (const info of this.manager.all()) {
      this.attachToProvider(info.name, info.provider);
    }

    this.manager.onDidRegister((info) => {
      if (this.disposed) return;
      this.reporter.report({
        type: 'provider.registry',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'ProviderMonitor',
        provider: info.name,
        action: 'registered',
        capabilities: info.metadata.capabilities,
        priority: info.metadata.priority,
      } as any);
      this.attachToProvider(info.name, info.provider);
    });

    this.manager.onDidUnregister(({ name }) => {
      if (this.disposed) return;
      this.cleanupProvider(name);
      this.reporter.report({
        type: 'provider.registry',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'ProviderMonitor',
        provider: name,
        action: 'unregistered',
      } as any);
    });

    this.manager.onDidChangeProviderState(({ name, oldState, newState }) => {
      if (this.disposed) return;
      this.handleStateChange(name, oldState, newState);
    });

    this.manager.onDidScanProgress((progress: ScanProgress) => {
      if (this.disposed) return;
      this.handleScanProgress(progress);
    });
  }

  private attachToProvider(name: string, provider: DiagnosticProvider): void {
    provider.onDidUpdate((uris) => {
      if (this.disposed) return;
      let errors = 0;
      let warnings = 0;
      let infos = 0;
      for (const uri of uris) {
        const state = provider.store.get(uri);
        if (state) {
          errors += state.errorCount;
          warnings += state.warningCount;
          infos += state.infoCount;
        }
      }
      const elapsed = Date.now() - (this.scanTimestamps.get(name) ?? Date.now());
      this.reporter.report({
        type: 'provider.scan',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'ProviderMonitor',
        provider: name,
        phase: 'end',
        scanPhase: 'completed',
        executionTimeMs: elapsed,
        uriCount: uris.length,
        diagnosticSummary: { errors, warnings, infos },
      } as any);
      this.scanTimestamps.delete(name);
      this.scanning.delete(name);
    });
  }

  private cleanupProvider(name: string): void {
    this.stateTimestamps.delete(name);
    this.scanTimestamps.delete(name);
    this.scanning.delete(name);
  }

  private handleStateChange(name: string, oldState: ProviderState, newState: ProviderState): void {
    const now = Date.now();
    const traceId = generateTraceId();
    const source = 'ProviderMonitor';

    if (newState === ProviderState.initializing || newState === ProviderState.running) {
      this.stateTimestamps.set(name, now);
    }

    const phase: 'initialize' | 'start' | 'stop' | 'dispose' | undefined =
      newState === ProviderState.initializing ? 'initialize' :
      newState === ProviderState.running ? 'start' :
      newState === ProviderState.disposed ? 'dispose' :
      oldState === ProviderState.running && newState === ProviderState.idle ? 'stop' :
      undefined;

    if (!phase) {
      if (newState === ProviderState.error) {
        this.reporter.report({
          type: 'provider.error',
          timestamp: now,
          traceId,
          source,
          provider: name,
          oldState,
          newState,
          executionTimeMs: now - (this.stateTimestamps.get(name) ?? now),
        } as any);
      }
      return;
    }

    this.reporter.report({
      type: 'provider.lifecycle',
      timestamp: now,
      traceId,
      source,
      provider: name,
      phase,
      oldState,
      newState,
      executionTimeMs: 0,
      success: newState !== ProviderState.error,
      error: newState === ProviderState.error ? `Provider entered error state after ${phase}` : undefined,
    } as any);

    if (newState === ProviderState.disposed) {
      this.cleanupProvider(name);
    }
  }

  private handleScanProgress(progress: ScanProgress): void {
    const now = Date.now();
    const traceId = generateTraceId();
    const name = progress.providerName;
    const source = 'ProviderMonitor';

    switch (progress.phase) {
      case 'resolving':
      case 'scanning':
      case 'parsing':
      case 'writing': {
        const isNewScan = !this.scanning.get(name);
        if (isNewScan) {
          this.scanTimestamps.set(name, now);
          this.scanning.set(name, true);
        }
        this.reporter.report({
          type: 'provider.scan',
          timestamp: now,
          traceId,
          source,
          provider: name,
          phase: 'begin',
          scanPhase: progress.phase,
          executionTimeMs: isNewScan ? 0 : now - (this.scanTimestamps.get(name) ?? now),
          message: progress.message,
        } as any);
        break;
      }

      case 'cancelled': {
        this.scanning.delete(name);
        this.reporter.report({
          type: 'provider.scan',
          timestamp: now,
          traceId,
          source,
          provider: name,
          phase: 'cancelled',
          scanPhase: 'cancelled',
          executionTimeMs: now - (this.scanTimestamps.get(name) ?? now),
          message: progress.message,
        } as any);
        this.scanTimestamps.delete(name);
        break;
      }

      case 'error': {
        this.scanning.delete(name);
        this.reporter.report({
          type: 'provider.scan',
          timestamp: now,
          traceId,
          source,
          provider: name,
          phase: 'error',
          scanPhase: 'error',
          executionTimeMs: now - (this.scanTimestamps.get(name) ?? now),
          message: progress.message,
          error: progress.detail ?? progress.message ?? 'Unknown scan error',
        } as any);
        this.scanTimestamps.delete(name);
        break;
      }
    }
  }

  /** Dispose the monitor */
  dispose(): void {
    this.disposed = true;
    this.stateTimestamps.clear();
    this.scanTimestamps.clear();
    this.scanning.clear();
  }
}

/** Create a ProviderMonitor attached to the given manager and reporter */
export function createProviderMonitor(
  manager: DiagnosticProviderManager,
  reporter: TelemetryReporter
): ProviderMonitor {
  return new ProviderMonitor(manager, reporter);
}