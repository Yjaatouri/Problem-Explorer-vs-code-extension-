import { Event, EventEmitter, Disposable, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';

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

  private readonly _onDidRegister = new EventEmitter<ProviderInfo>();
  readonly onDidRegister: Event<ProviderInfo> = this._onDidRegister.event;

  private readonly _onDidUnregister = new EventEmitter<{ name: string }>();
  readonly onDidUnregister: Event<{ name: string }> = this._onDidUnregister.event;

  private readonly _onDidChangeProviderState = new EventEmitter<{ name: string; oldState: ProviderState; newState: ProviderState }>();
  readonly onDidChangeProviderState: Event<{ name: string; oldState: ProviderState; newState: ProviderState }> = this._onDidChangeProviderState.event;

  private readonly _onDidUpdateAll = new EventEmitter<Uri[]>();
  readonly onDidUpdateAll: Event<Uri[]> = this._onDidUpdateAll.event;

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

    const sub = provider.onDidUpdate((uris: Uri[]) => {
      this._onDidUpdateAll.fire(uris);
    });
    this.providerSubscriptions.set(name, sub);

    this._onDidRegister.fire({
      name,
      provider,
      metadata: resolved,
      state: ProviderState.idle,
    });
  }

  unregister(name: string): boolean {
    this.ensureNotDisposed();
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (this._started) {
      try { entry.provider.stop(); } catch {}
    }
    this.entries.delete(name);
    try { entry.provider.dispose(); } catch {}
    this.cleanupProviderSub(name);
    this._onDidUnregister.fire({ name });
    return true;
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

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._started = false;
    for (const [name, entry] of this.entries) {
      this.setProviderState(name, ProviderState.disposed);
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
