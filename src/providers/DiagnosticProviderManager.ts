import { Event, EventEmitter, Disposable, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ScanProgress } from '../core/types';
import { chainCounters } from '../forensicLogger';

export enum ProviderState {
  idle = 'idle',
  initializing = 'initializing',
  running = 'running',
  error = 'error',
  disposed = 'disposed',
}

export interface ProviderMetadata {
  priority?: number;
  capabilities?: string[];
}

export interface ProviderInfo {
  readonly name: string;
  readonly provider: DiagnosticProvider;
  readonly metadata: Required<ProviderMetadata>;
  readonly state: ProviderState;
}

interface ProviderEntry {
  provider: DiagnosticProvider;
  metadata: Required<ProviderMetadata>;
  state: ProviderState;
}

export class DiagnosticProviderManager {
  private readonly entries = new Map<string, ProviderEntry>();
  private _started = false;
  private _disposed = false;
  /** extension → canonical provider name */
  private _ownershipMap = new Map<string, string>();

  private readonly _onDidRegister = new EventEmitter<ProviderInfo>();
  readonly onDidRegister: Event<ProviderInfo> = this._onDidRegister.event;

  private readonly _onDidUnregister = new EventEmitter<{ name: string }>();
  readonly onDidUnregister: Event<{ name: string }> = this._onDidUnregister.event;

  private readonly _onDidChangeProviderState = new EventEmitter<{ name: string; oldState: ProviderState; newState: ProviderState }>();
  readonly onDidChangeProviderState: Event<{ name: string; oldState: ProviderState; newState: ProviderState }> = this._onDidChangeProviderState.event;

  private readonly _onDidUpdateAll = new EventEmitter<Uri[]>();
  readonly onDidUpdateAll: Event<Uri[]> = this._onDidUpdateAll.event;

  private readonly _onDidScanProgress = new EventEmitter<ScanProgress>();
  readonly onDidScanProgress: Event<ScanProgress> = this._onDidScanProgress.event;

  private readonly providerSubscriptions = new Map<string, Disposable>();

  get size(): number { return this.entries.size; }
  get started(): boolean { return this._started; }
  get disposed(): boolean { return this._disposed; }

  register(name: string, provider: DiagnosticProvider, metadata?: ProviderMetadata): void {
    this.ensureNotDisposed();
    if (this.entries.has(name)) {
      throw new Error(`Provider "${name}" is already registered`);
    }
    const resolved: Required<ProviderMetadata> = {
      priority: metadata?.priority ?? 0,
      capabilities: metadata?.capabilities ?? [],
    };
    const entry: ProviderEntry = { provider, metadata: resolved, state: ProviderState.idle };
    this.entries.set(name, entry);

    const updateSub = provider.onDidUpdate((uris: Uri[]) => {
      chainCounters.dpmOnDidUpdateReceived++;
      console.log(`[LOG:DPMgr] onDidUpdate received from "${name}" — ${uris.length} URIs — firing _onDidUpdateAll`);
      this._onDidUpdateAll.fire(uris);
    });
    const progressSub = provider.onDidProgressScan((progress: ScanProgress) => {
      chainCounters.dpmOnProgressReceived++;
      console.log(`[LOG:DPMgr] onDidProgressScan from "${name}" — phase=${progress.phase} msg=${progress.message ?? ''}`);
      this._onDidScanProgress.fire(progress);
    });
    this.providerSubscriptions.set(name, Disposable.from(updateSub, progressSub));

    this._onDidRegister.fire({
      name,
      provider,
      metadata: resolved,
      state: ProviderState.idle,
    });

    this._rebuildOwnership();
  }

  unregister(name: string): boolean {
    this.ensureNotDisposed();
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (this._started) {
      try { entry.provider.stop(); } catch {}
    }
    // Release ownership in ProblemStore
    try { entry.provider.releaseOwnership?.(); } catch {}
    this.entries.delete(name);
    try { entry.provider.dispose(); } catch {}
    this.cleanupProviderSub(name);
    this._onDidUnregister.fire({ name });
    this._rebuildOwnership();
    return true;
  }

  /**
   * Return the canonical provider name that owns the given extension,
   * or `undefined` if no scan provider claims it (falls to realtime).
   */
  getOwner(extension: string): string | undefined {
    this.ensureNotDisposed();
    return this._ownershipMap.get(extension);
  }

  /**
   * Return all extensions owned by the named provider.
   */
  getOwnedExtensions(providerName: string): readonly string[] {
    this.ensureNotDisposed();
    const result: string[] = [];
    for (const [ext, owner] of this._ownershipMap) {
      if (owner === providerName) result.push(ext);
    }
    return result;
  }

  /**
   * Return true if the named provider is the owner of the given extension.
   */
  canProviderProcess(providerName: string, extension: string): boolean {
    this.ensureNotDisposed();
    return this._ownershipMap.get(extension) === providerName;
  }

  get(name: string): DiagnosticProvider | undefined {
    this.ensureNotDisposed();
    return this.entries.get(name)?.provider;
  }

  getInfo(name: string): ProviderInfo | undefined {
    this.ensureNotDisposed();
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return { name, provider: entry.provider, metadata: entry.metadata, state: entry.state };
  }

  getProviderState(name: string): ProviderState | undefined {
    this.ensureNotDisposed();
    return this.entries.get(name)?.state;
  }

  setProviderState(name: string, state: ProviderState): void {
    this.ensureNotDisposed();
    const entry = this.entries.get(name);
    if (!entry) return;
    const oldState = entry.state;
    if (oldState === state) return;
    entry.state = state;
    this._onDidChangeProviderState.fire({ name, oldState, newState: state });
  }

  all(): ProviderInfo[] {
    this.ensureNotDisposed();
    return Array.from(this.entries.entries()).map(([name, entry]) => ({
      name,
      provider: entry.provider,
      metadata: entry.metadata,
      state: entry.state,
    }));
  }

  getByState(state: ProviderState): ProviderInfo[] {
    return this.all().filter((e) => e.state === state);
  }

  getByCapability(capability: string): ProviderInfo[] {
    return this.all().filter((e) => e.metadata.capabilities.includes(capability));
  }

  hasCapability(name: string, capability: string): boolean {
    this.ensureNotDisposed();
    const entry = this.entries.get(name);
    return entry ? entry.metadata.capabilities.includes(capability) : false;
  }

  async initializeAll(): Promise<void> {
    this.ensureNotDisposed();
    for (const [name, entry] of this.sortedEntries()) {
      this.setProviderState(name, ProviderState.initializing);
      try {
        await entry.provider.initialize();
        this.setProviderState(name, ProviderState.idle);
      } catch (e) {
        this.setProviderState(name, ProviderState.error);
        console.error(`[DiagnosticProviderManager] initialize "${name}" failed:`, e);
      }
    }
  }

  startAll(): void {
    this.ensureNotDisposed();
    this._started = true;
    for (const [name, entry] of this.sortedEntries()) {
      try {
        entry.provider.start();
        this.setProviderState(name, ProviderState.running);
      } catch (e) {
        this.setProviderState(name, ProviderState.error);
        console.error(`[DiagnosticProviderManager] start "${name}" failed:`, e);
      }
    }
  }

  stopAll(): void {
    this.ensureNotDisposed();
    this._started = false;
    const reversed = this.sortedEntries().reverse();
    for (const [name, entry] of reversed) {
      try {
        entry.provider.stop();
        // Release ownership so other providers can claim keys
        entry.provider.releaseOwnership?.();
        if (entry.state !== ProviderState.disposed && entry.state !== ProviderState.error) {
          this.setProviderState(name, ProviderState.idle);
        }
      } catch (e) {
        console.error(`[DiagnosticProviderManager] stop "${name}" failed:`, e);
      }
    }
  }

  refreshAll(): void {
    this.ensureNotDisposed();
    for (const [name, entry] of this.sortedEntries()) {
      try {
        entry.provider.refresh();
      } catch (e) {
        console.error(`[DiagnosticProviderManager] refresh "${name}" failed:`, e);
      }
    }
  }

  async refreshByNames(names: string[]): Promise<void> {
    this.ensureNotDisposed();
    const promises: Promise<void>[] = [];
    for (const name of names) {
      const entry = this.entries.get(name);
      if (!entry) continue;
      try {
        const result = entry.provider.refresh();
        if (result instanceof Promise) {
          promises.push(result);
        }
      } catch (e) {
        console.error(`[DiagnosticProviderManager] refresh "${name}" failed:`, e);
      }
    }
    await Promise.all(promises);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._started = false;
    for (const [name, entry] of this.entries) {
      this.setProviderState(name, ProviderState.disposed);
      // Release ownership before disposing
      try { entry.provider.releaseOwnership?.(); } catch {}
      try { entry.provider.dispose(); } catch {}
    }
    this.entries.clear();
    for (const sub of this.providerSubscriptions.values()) {
      try { sub.dispose(); } catch {}
    }
    this.providerSubscriptions.clear();
    this._onDidRegister.dispose();
    this._onDidUnregister.dispose();
    this._onDidChangeProviderState.dispose();
    this._onDidUpdateAll.dispose();
    this._onDidScanProgress.dispose();
  }

  /**
   * Rebuild the extension → owner map from all registered providers.
   * For each extension, the highest-priority non-realtime provider that
   * declares it wins. Ties are broken by first-registered-first.
   */
  private _rebuildOwnership(): void {
    const newMap = new Map<string, string>();
    const sorted = this.sortedEntries();
    for (const [, entry] of sorted) {
      const providerName = entry.provider.name;
      const caps = entry.provider.capabilities;
      if (caps.realtime) continue;
      for (const ext of caps.extensions) {
        if (!newMap.has(ext)) {
          newMap.set(ext, providerName);
        }
      }
    }
    this._ownershipMap = newMap;
  }

  private sortedEntries(): Array<[string, ProviderEntry]> {
    return Array.from(this.entries.entries()).sort(
      ([, a], [, b]) => b.metadata.priority - a.metadata.priority,
    );
  }

  private cleanupProviderSub(name: string): void {
    const sub = this.providerSubscriptions.get(name);
    if (sub) {
      try { sub.dispose(); } catch {}
      this.providerSubscriptions.delete(name);
    }
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('DiagnosticProviderManager is disposed');
    }
  }
}
