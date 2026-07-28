import { Disposable } from 'vscode';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';

/**
 * Identifies who requested the scan and why. Every scan request flowing
 * through the scheduler carries this metadata so that downstream
 * consumers (telemetry, logging, future prioritisation logic) can reason
 * about the source without inspecting call stacks.
 */
export type ScanSource =
  | 'autoscan'
  | 'startup'
  | 'manual'
  | 'config-change'
  | 'realtime';

/**
 * The single, structured entry point for all scan requests.
 *
 * Every scan in the system — save-triggered auto-scans, startup scans,
 * manual "Scan Workspace" invocations, config-change re-enable triggers,
 * and realtime-driven refreshes — must go through `ScanScheduler.submit()`.
 *
 * No subsystem should call `provider.refresh()` or
 * `manager.refreshByNames()` directly. The scheduler is the only funnel.
 *
 * **Task 1 scope:** The scheduler is a pure pass-through. It delegates to
 * the existing `DiagnosticProviderManager.refreshByNames()` code path with
 * zero changes to timing, ordering, cancellation, or debouncing. The
 * purpose is to establish the single entry point and migrate all callers;
 * the actual scheduling algorithm will be built in subsequent tasks.
 */
export interface ScanRequest {
  /** Provider ids to scan. Must match `descriptor.id` / `provider.name`. */
  readonly providerNames: readonly string[];
  /** Why the scan was requested — short human-readable string for logs. */
  readonly reason: string;
  /** Which subsystem initiated the request. */
  readonly source: ScanSource;
}

/**
 * Result of attempting to schedule a scan. Distinguishes between
 * "submitted for execution" and "suppressed because no providers matched."
 */
export interface ScanSubmitResult {
  readonly submitted: boolean;
  readonly providerNames: readonly string[];
  readonly reason: string;
  readonly source: ScanSource;
}

/**
 * The central `ScanScheduler` is the single entry point for all scan
 * requests in the extension. It wraps `DiagnosticProviderManager` and
 * `ProviderRegistry` so that every caller — `AutoScanController`,
 * `StartupScanController`, `ScanWorkspaceButton`, `CommandManager`, and
 * `extension.ts` config-change handlers — routes through one funnel.
 *
 * **Current behaviour (Task 1):** The scheduler delegates directly to
 * `manager.refreshByNames()` with no additional debounce, queue, or
 * cancellation logic. This preserves exact current behaviour while
 * establishing the single choke point that future tasks will build on.
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
   * Submit a scan request for specific providers.
   *
   * Delegates to `DiagnosticProviderManager.refreshByNames()` — the same
   * code path that all callers used before the scheduler existed.
   *
   * Providers that are not registered or not enabled are silently filtered
   * out by `refreshByNames()` (it skips entries it can't find). The
   * scheduler does not add any additional filtering in Task 1.
   */
  async submit(request: ScanRequest): Promise<ScanSubmitResult> {
    this.ensureNotDisposed();
    const { providerNames, reason, source } = request;

    if (providerNames.length === 0) {
      this._log(`[SCAN-SCHEDULER] ${source}: empty provider list — skipping (${reason})`);
      return { submitted: false, providerNames: [], reason, source };
    }

    this._log(`[SCAN-SCHEDULER] ${source}: requesting scan for [${providerNames.join(', ')}] (${reason})`);

    await this._manager.refreshByNames([...providerNames]);

    return { submitted: true, providerNames, reason, source };
  }

  /**
   * Submit a scan for all registered providers.
   *
   * Equivalent to the old `manager.refreshAll()` path, but routed through
   * `refreshByNames()` for consistency (both call `provider.refresh()`
   * and collect promises).
   */
  async submitAll(source: ScanSource, reason: string): Promise<ScanSubmitResult> {
    this.ensureNotDisposed();
    const names = this._registry.all()
      .filter((rp) => rp.provider.enabled)
      .map((rp) => rp.descriptor.id);
    return this.submit({ providerNames: names, reason, source });
  }

  /**
   * Look up the owner of a file extension and submit a scan for that
   * provider. Returns the provider id that was scheduled, or `undefined`
   * if no scanner owns the extension (e.g., it falls through to the
   * realtime provider).
   *
   * This replaces the pattern that `AutoScanController` used:
   * ```
   * const owner = registry.getOwner(ext);
   * if (!owner) return;
   * provider.refresh();
   * ```
   */
  submitForExtension(
    ext: string,
    source: ScanSource,
    reason: string,
  ): ScanSubmitResult {
    this.ensureNotDisposed();
    const ownerName = this._registry.getOwner(ext);
    if (!ownerName) {
      return { submitted: false, providerNames: [], reason, source };
    }
    // Fire-and-forget — callers that need to await should use submit().
    void this.submit({ providerNames: [ownerName], reason, source });
    return { submitted: true, providerNames: [ownerName], reason, source };
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
