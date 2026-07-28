import { Disposable, Uri } from 'vscode';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';
import {
  ScanSource,
  ScanJobRequest,
  ScanJobResult,
  ScanJob,
  ScanPriority,
  computeScanPriority,
  generateJobId,
} from './ScanJob';

/**
 * The central `ScanScheduler` is the single entry point for all scan
 * requests in the extension. It wraps `DiagnosticProviderManager` and
 * `ProviderRegistry` so that every caller — `AutoScanController`,
 * `StartupScanController`, `ScanWorkspaceButton`, `CommandManager`, and
 * `extension.ts` config-change handlers — routes through one funnel.
 *
 * **Task 2 scope:** The scheduler now creates a `ScanJob` for each request,
 * computes priority from event tier + provider priority, and delegates to
 * `DiagnosticProviderManager.refreshByNames()`. Still a pass-through for
 * execution; the job model is established for Task 3 scheduling logic.
 */
export class ScanScheduler implements Disposable {
  private readonly _registry: ProviderRegistry;
  private readonly _manager: DiagnosticProviderManager;
  private readonly _log: (msg: string) => void;
  private _disposed = false;

  constructor(
    registry: ProviderRegistry,
    manager: DiagnosticProviderManager,
    log: (msg: string) => void,
  ) {
    this._registry = registry;
    this._manager = manager;
    this._log = log;
  }

  /**
   * Submit a scan request. Creates a ScanJob, computes priority,
   * and delegates to `DiagnosticProviderManager.refreshByNames()`.
   */
  async submit(request: ScanJobRequest): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const { providerNames, reason, source, uris = [], signal } = request;

    if (providerNames.length === 0) {
      this._log(`[SCAN-SCHEDULER] ${source}: empty provider list — skipping (${reason})`);
      return { submitted: false, providerNames: [], reason, source, skipReason: 'no providers' };
    }

    // Compute priority: event tier + provider base priority
    const eventTier = this.sourceToTier(source);
    const basePriority = providerNames.length === 1
      ? this._registry.getPriority(providerNames[0]) ?? 0
      : 0;
    const priority = computeScanPriority(eventTier, basePriority);

    const job: ScanJob = {
      provider: providerNames[0], // primary provider
      reason,
      uris,
      priority,
      timestamp: Date.now(),
      signal,
      jobId: generateJobId(),
    };

    this._log(`[SCAN-SCHEDULER] ${source}: job ${job.jobId} for [${providerNames.join(', ')}] pri=${priority} (${reason})`);

    await this._manager.refreshByNames([...providerNames]);

    return { submitted: true, providerNames, reason, source, job };
  }

  /**
   * Submit a scan for all registered providers.
   */
  async submitAll(source: ScanSource, reason: string, uris: readonly Uri[] = []): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const names = this._registry.all()
      .filter((rp) => rp.provider.enabled)
      .map((rp) => rp.descriptor.id);
    return this.submit({ providerNames: names, reason, source, uris });
  }

  /**
   * Look up the owner of a file extension and submit a scan for that
   * provider. Returns the provider id that was scheduled, or `undefined`
   * if no scanner owns the extension.
   */
  submitForExtension(
    ext: string,
    source: ScanSource,
    reason: string,
    uris: readonly Uri[] = [],
  ): ScanJobResult {
    this.ensureNotDisposed();
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason, source, skipReason: 'no owner for extension' };
    }
    // Fire-and-forget — callers that need to await should use submit().
    void this.submit({ providerNames: [ownerName], reason, source, uris });
    return { submitted: true, providerNames: [ownerName], reason, source };
  }

  /** Map a ScanSource to its ScanPriority tier. */
  private sourceToTier(source: ScanSource): ScanPriority {
    switch (source) {
      case 'manual': return ScanPriority.Manual;
      case 'config-change': return ScanPriority.ConfigChange;
      case 'startup': return ScanPriority.Startup;
      case 'autoscan': return ScanPriority.Save; // save is the primary autoscan trigger
      case 'realtime': return ScanPriority.Realtime;
      default: return ScanPriority.Save;
    }
  }

  /** The wrapped DiagnosticProviderManager (for back-compat). */
  get manager(): DiagnosticProviderManager { return this._manager; }

  /** The wrapped ProviderRegistry. */
  get registry(): ProviderRegistry { return this._registry; }

  dispose(): void {
    this._disposed = true;
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('ScanScheduler is disposed');
    }
  }
}
