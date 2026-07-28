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
 * **Task 4 scope:** The scheduler now owns all provider-routing logic.
 * Controllers emit raw events (file save, startup, config change, etc.);
 * the scheduler resolves the correct providers via the ProviderRegistry
 * (extension ownership, capability filtering, enabled state, config gates).
 * No hardcoded provider names or capability checks remain in controllers.
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
   * Route a file-save event to the owning scanner provider.
   * Resolves extension → owner, checks provider's autoScan config gate,
   * and submits if appropriate.
   */
  async routeFileSave(uri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const ext = this.extractExtension(uri);
    if (!ext) {
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'no extension' };
    }
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'no owner for extension' };
    }
    // Per-provider autoScan gate — user may disable auto-scan for specific providers.
    const providerCfg = this._registry.getProviderConfig(ownerName);
    if (providerCfg && !providerCfg.autoScan) {
      return { submitted: false, providerNames: [], reason: 'file save', source: 'autoscan', skipReason: 'provider autoScan disabled' };
    }
    const result = await this.submit({ providerNames: [ownerName], reason: 'file save', source: 'autoscan', uris: [uri] });
    return result;
  }

  /**
   * Route a file-create event (same logic as save for now).
   */
  async routeFileCreate(uri: Uri): Promise<ScanJobResult> {
    return this.routeFileSave(uri); // same logic: extension → owner → autoScan gate
  }

  /**
   * Route a file-rename event. Checks both old and new extensions.
   */
  async routeFileRename(oldUri: Uri, newUri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const oldExt = this.extractExtension(oldUri);
    const newExt = this.extractExtension(newUri);
    const ownerNames = new Set<string>();

    // Old extension owner — may need cleanup (handled by diagnostics manager)
    if (oldExt) {
      const oldOwner = this._registry.getOwner(oldExt);
      if (oldOwner) ownerNames.add(oldOwner);
    }
    // New extension owner — trigger scan
    if (newExt) {
      const newOwner = this._registry.getOwner(newExt);
      if (newOwner) {
        const providerCfg = this._registry.getProviderConfig(newOwner);
        if (!providerCfg || providerCfg.autoScan) {
          ownerNames.add(newOwner);
        }
      }
    }

    const owners = [...ownerNames];
    if (owners.length === 0) {
      return { submitted: false, providerNames: [], reason: 'file rename', source: 'autoscan', skipReason: 'no owner for extensions' };
    }
    return this.submit({ providerNames: owners, reason: 'file rename', source: 'autoscan', uris: [oldUri, newUri] });
  }

  /**
   * Route a file-delete event. For delete, we primarily need to clear
   * ownership/stale badges. The diagnostics manager handles this via
   * onDidDeleteFiles listeners. The scheduler can route to the old owner
   * for any cleanup scan if needed.
   */
  async routeFileDelete(uri: Uri): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const ext = this.extractExtension(uri);
    if (!ext) {
      return { submitted: false, providerNames: [], reason: 'file delete', source: 'autoscan', skipReason: 'no extension' };
    }
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason: 'file delete', source: 'autoscan', skipReason: 'no owner for extension' };
    }
    // For delete, we could trigger a cleanup scan, but the diagnostics
    // manager's onDidDeleteFiles + clearIfOwner handles badge removal.
    // Submit a lightweight scan for the owner to refresh its state.
    return this.submit({ providerNames: [ownerName], reason: 'file delete', source: 'autoscan', uris: [uri] });
  }

  /**
   * Route the startup scan event.
   * Resolves all providers with startupScan capability that are enabled
   * and not disabled by config (scanOnStartup: false).
   */
  async routeStartup(): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const candidates = this._registry.all().filter((rp) => {
      const caps = rp.provider.capabilities;
      if (!caps.startupScan) return false;
      if (!rp.provider.enabled) return false;
      const providerCfg = this._registry.getProviderConfig(rp.descriptor.id);
      if (providerCfg && !providerCfg.scanOnStartup) return false;
      return true;
    });
    const names = candidates.map((rp) => rp.descriptor.id);
    if (names.length === 0) {
      this._log('[SCAN-SCHEDULER] startup: no providers with startupScan enabled');
      return { submitted: false, providerNames: [], reason: 'startup scan', source: 'startup', skipReason: 'no providers with startupScan' };
    }
    this._log(`[SCAN-SCHEDULER] startup: routing [${names.join(', ')}]`);
    return this.submit({ providerNames: names, reason: 'startup scan', source: 'startup' });
  }

  /**
   * Route a config-change re-enable event for specific providers.
   * Accepts provider ids that were just enabled.
   */
  async routeConfigReEnable(providerIds: string[]): Promise<ScanJobResult> {
    this.ensureNotDisposed();
    const validNames = providerIds.filter((id) => {
      const rp = this._registry.all().find((rp) => rp.descriptor.id === id);
      return rp && rp.provider.enabled;
    });
    if (validNames.length === 0) {
      return { submitted: false, providerNames: [], reason: 'config re-enable', source: 'config-change', skipReason: 'no valid enabled providers' };
    }
    this._log(`[SCAN-SCHEDULER] config-change: re-enabled [${validNames.join(', ')}]`);
    return this.submit({ providerNames: validNames, reason: 'config re-enable', source: 'config-change' });
  }

  /**
   * Route a config change that disabled a provider.
   * This is informational — we log and the scheduler does NOT submit a scan.
   * Ownership is cleared via the provider's updateConfig() → releaseOwnership().
   */
  routeConfigDisable(providerIds: string[]): ScanJobResult {
    this.ensureNotDisposed();
    this._log(`[SCAN-SCHEDULER] config-change: disabled [${providerIds.join(', ')}] — ownership released by providers`);
    return { submitted: false, providerNames: [], reason: 'config disable', source: 'config-change', skipReason: 'ownership released by providers' };
  }
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

  /** Extract file extension from URI (lowercase, with leading dot). */
  private extractExtension(uri: Uri): string | null {
    const path = uri.fsPath;
    const dot = path.lastIndexOf('.');
    if (dot < 0) return null;
    return path.slice(dot).toLowerCase();
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
