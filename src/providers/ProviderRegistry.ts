import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { DiagnosticProviderManager, ProviderInfo, ProviderState } from './DiagnosticProviderManager';
import { ProblemStore } from '../store/ProblemStore';
import { ProviderCapabilities, ScanProgress } from '../core/types';

/**
 * Provider type discriminator.
 * - `scanner`: runs on demand (autoscan, manual refresh, startup) and claims
 *   ownership of file extensions in the registry's ownership map.
 * - `realtime`: listens to an external event source (e.g. VS Code diagnostics)
 *   and never claims extension ownership; it always yields to scanners.
 */
export type ProviderType = 'scanner' | 'realtime';

/**
 * Static, declarative metadata for a provider. Declared once at registration
 * time; becomes the single source of truth for the provider's identity,
 * priority, capabilities, and default-enabled state.
 */
export interface ProviderDescriptor {
  /** Stable unique id; matches `DiagnosticProvider.name`. */
  readonly id: string;
  /** Human-readable name shown in the dashboard / logs. */
  readonly displayName: string;
  /** Higher number wins ownership conflicts. Single source of truth — written
   * to both DiagnosticProviderManager and ProblemStore by the registry. */
  readonly priority: number;
  /** Discriminator: scanner vs realtime. Derived from capabilities.realtime
   * if omitted. */
  readonly type?: ProviderType;
  /** The typed capability set. Single source of truth for capabilities. */
  readonly capabilities: ProviderCapabilities;
  /** Default enabled state — used when user config does not override. */
  readonly defaultEnabled: boolean;
}

/**
 * A provider + its descriptor + runtime state. Returned by enumeration APIs.
 */
export interface RegisteredProvider extends ProviderInfo {
  readonly descriptor: ProviderDescriptor;
}

/**
 * The ProviderRegistry is the single source of truth for provider registration.
 * It wraps DiagnosticProviderManager (event aggregation) and ProblemStore
 * (priority gate), writing priority and capabilities to BOTH in one call so
 * they can never drift.
 *
 * Consumers ask the registry for: enumeration, metadata lookup, enabled/priority
 * lookup, and extension→provider ownership lookup. They no longer need to call
 * `dpm.register` and `problemStore.configureProvider` separately.
 */
export class ProviderRegistry implements Disposable {
  private readonly _dpm: DiagnosticProviderManager;
  private readonly _store: ProblemStore;
  /** id → descriptor (single source of truth) */
  private readonly _descriptors = new Map<string, ProviderDescriptor>();
  /** extension → provider id (ownership map) — mirrors dpm._ownershipMap but
   * registry is the sole writer. */
  private _ownershipMap = new Map<string, string>();
  private _disposed = false;

  private readonly _onDidRegister = new EventEmitter<RegisteredProvider>();
  readonly onDidRegister: Event<RegisteredProvider> = this._onDidRegister.event;

  private readonly _onDidUnregister = new EventEmitter<{ id: string }>();
  readonly onDidUnregister: Event<{ id: string }> = this._onDidUnregister.event;

  constructor(dpm: DiagnosticProviderManager, store: ProblemStore) {
    this._dpm = dpm;
    this._store = store;
    // Re-publish DPM events for consumers that want a unified surface.
    // We don't re-emit `onDidRegister` from DPM because the registry's own
    // event carries the richer RegisteredProvider (with descriptor).
  }

  /**
   * Register a provider. Single source of truth for priority and capabilities:
   * writes to both DiagnosticProviderManager and ProblemStore.
   */
  register(provider: DiagnosticProvider, descriptor: ProviderDescriptor): void {
    this.ensureNotDisposed();
    if (descriptor.id !== provider.name) {
      throw new Error(`Descriptor id "${descriptor.id}" must match provider.name "${provider.name}"`);
    }
    if (this._descriptors.has(descriptor.id)) {
      throw new Error(`Provider "${descriptor.id}" is already registered`);
    }
    // Validate id == provider.name so consumers can always trust either one
    // (the dpm requires the same via its register() call, but here we own it).
    const type = descriptor.type ?? (descriptor.capabilities.realtime ? 'realtime' : 'scanner');

    // Write to DPM (which fails if dups). Use the descriptor's capabilities
    // to derive the (legacy) free-form tag list so there's exactly one source
    // of capabilities — T0.6 will flip consumers over to `descriptor.type` /
    // `descriptor.capabilities` directly and we can drop the tag list.
    const tags = deriveCapabilityTags(descriptor.capabilities, type);
    this._dpm.register(descriptor.id, provider, {
      priority: descriptor.priority,
      capabilities: tags,
    });

    // Write priority to ProblemStore (single source of truth = descriptor).
    this._store.configureProvider(descriptor.id, descriptor.priority);

    this._descriptors.set(descriptor.id, { ...descriptor, type });

    // Rebuild ownership map from the descriptor set (registry owns the map).
    this.rebuildOwnership();

    this._onDidRegister.fire({
      name: descriptor.id,
      provider,
      metadata: { priority: descriptor.priority, capabilities: tags },
      state: ProviderState.idle,
      descriptor: { ...descriptor, type },
    });
  }

  /** Unregister a provider. Releases store ownership and disposes the provider. */
  unregister(id: string): void {
    this.ensureNotDisposed();
    const descriptor = this._descriptors.get(id);
    if (!descriptor) return;
    this._dpm.unregister(id);
    this._store.unconfigureProvider(id);
    this._descriptors.delete(id);
    // Ownership is rebuilt below; also unconfigureProvider calls releaseOwnership
    // internally on ProblemStore, so store entries are released.
    this.rebuildOwnership();
    this._onDidUnregister.fire({ id });
  }

  /** Look up a registered provider by id. */
  get(id: string): RegisteredProvider | undefined {
    const provider = this._dpm.get(id);
    const info = this._dpm.all().find((info) => info.name === id);
    if (!provider || !info) return undefined;
    const descriptor = this._descriptors.get(id);
    if (!descriptor) return undefined;
    return { ...info, descriptor };
  }

  /** Get the DiagnosticProvider instance by id. */
  getProvider(id: string): DiagnosticProvider | undefined {
    return this._dpm.get(id);
  }

  /** Enumerate all registered providers in priority order (highest first). */
  all(): readonly RegisteredProvider[] {
    const infos = this._dpm.all();
    const result: RegisteredProvider[] = [];
    for (const info of infos) {
      const descriptor = this._descriptors.get(info.name);
      if (descriptor) result.push({ ...info, descriptor });
    }
    return result;
  }

  /** Enumerate descriptors only (no provider instances). */
  descriptors(): readonly ProviderDescriptor[] {
    return Array.from(this._descriptors.values());
  }

  /** Get the descriptor for a provider id. */
  getDescriptor(id: string): ProviderDescriptor | undefined {
    return this._descriptors.get(id);
  }

  /** True if the provider exists and is enabled (runtime check via dpm). */
  isEnabled(id: string): boolean {
    const provider = this._dpm.get(id);
    return provider ? provider.enabled : false;
  }

  /** Get the priority for a provider id. Single source of truth: descriptor. */
  getPriority(id: string): number | undefined {
    return this._descriptors.get(id)?.priority;
  }

  /** Get the type for a provider id. */
  getType(id: string): ProviderType | undefined {
    return this._descriptors.get(id)?.type;
  }

  /**
   * Get the owning provider id for a file extension. Returns `undefined` for
   * realtime providers or unknown extensions — they fall through to the
   * realtime fallback (vscodeDiagnostics).
   */
  getOwner(extension: string): string | undefined {
    return this._ownershipMap.get(extension);
  }

  /** Get the list of extensions claimed by a provider id. */
  getOwnedExtensions(id: string): readonly string[] {
    const result: string[] = [];
    for (const [ext, ownerId] of this._ownershipMap) {
      if (ownerId === id) result.push(ext);
    }
    return result;
  }

  /**
   * Rebuild the ownership map from descriptors.
   * Rules mirror the original DPM logic:
   * - Skip disabled providers (read via dpm so the runtime `enabled` getter
   *   is the source — providers may toggle enabled via updateConfig).
   * - Skip realtime providers (they never own extensions).
   * - Sort by descending priority; ties broken by insertion order (Map iterates
   *   in insertion order; Node's sort is stable on V8 since Node 11).
   * - First provider to claim an extension wins.
   */
  rebuildOwnership(): void {
    const newMap = new Map<string, string>();
    const sorted = Array.from(this._descriptors.values()).sort(
      (a, b) => b.priority - a.priority,
    );
    for (const desc of sorted) {
      const provider = this._dpm.get(desc.id);
      if (!provider) continue;
      if (!provider.enabled) continue;
      const type = desc.type ?? (desc.capabilities.realtime ? 'realtime' : 'scanner');
      if (type === 'realtime') continue;
      const extensions = desc.capabilities.extensions;
      if (!extensions) continue;
      for (const ext of extensions) {
        if (!newMap.has(ext)) {
          newMap.set(ext, desc.id);
        }
      }
    }
    this._ownershipMap = newMap;
  }

  /** Forwarded events from DPM for consumers that want a unified surface. */
  get onDidUpdateAll(): Event<Uri[]> { return this._dpm.onDidUpdateAll; }
  get onDidScanProgress(): Event<ScanProgress> { return this._dpm.onDidScanProgress; }
  get onDidChangeProviderState() { return this._dpm.onDidChangeProviderState; }

  /** The wrapped DiagnosticProviderManager (for back-compat). */
  get manager(): DiagnosticProviderManager { return this._dpm; }

  /** The wrapped ProblemStore. */
  get store(): ProblemStore { return this._store; }

  /** Number of registered providers. */
  get size(): number { return this._descriptors.size; }

  /** True if the registry has been disposed. */
  get disposed(): boolean { return this._disposed; }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._onDidRegister.dispose();
    this._onDidUnregister.dispose();
    // DPM and store are owned by extension.ts; we don't dispose them here.
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('ProviderRegistry is disposed');
    }
  }
}

/**
 * Derive the legacy free-form capability tag list from the typed
 * ProviderCapabilities. This keeps the existing `hasCapability` / telemetry
 * consumers working during the transition (T0.6 will switch them over).
 */
function deriveCapabilityTags(caps: ProviderCapabilities, type: ProviderType): string[] {
  const tags: string[] = ['diagnostics'];
  if (type === 'realtime' || caps.realtime) tags.push('realtime');
  if (caps.manualScan) tags.push('manual-scan');
  if (caps.startupScan) tags.push('startup-scan');
  if (caps.fullWorkspace) tags.push('full-workspace');
  return tags;
}
