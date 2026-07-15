import { DiagnosticProvider } from './DiagnosticProvider';

export class DiagnosticProviderManager {
  private readonly providers = new Map<string, DiagnosticProvider>();
  private _started = false;
  private _disposed = false;

  get size(): number {
    return this.providers.size;
  }

  get started(): boolean {
    return this._started;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  register(name: string, provider: DiagnosticProvider): void {
    this.ensureNotDisposed();
    if (this.providers.has(name)) {
      throw new Error(`Provider "${name}" is already registered`);
    }
    this.providers.set(name, provider);
  }

  unregister(name: string): boolean {
    this.ensureNotDisposed();
    const provider = this.providers.get(name);
    if (!provider) return false;
    if (this._started) {
      try { provider.stop(); } catch {}
    }
    this.providers.delete(name);
    try { provider.dispose(); } catch {}
    return true;
  }

  get(name: string): DiagnosticProvider | undefined {
    return this.providers.get(name);
  }

  async initializeAll(): Promise<void> {
    this.ensureNotDisposed();
    for (const [name, provider] of this.providers) {
      try {
        await provider.initialize();
      } catch (e) {
        console.error(`[DiagnosticProviderManager] initialize "${name}" failed:`, e);
      }
    }
  }

  startAll(): void {
    this.ensureNotDisposed();
    this._started = true;
    for (const [name, provider] of this.providers) {
      try {
        provider.start();
      } catch (e) {
        console.error(`[DiagnosticProviderManager] start "${name}" failed:`, e);
      }
    }
  }

  stopAll(): void {
    this.ensureNotDisposed();
    this._started = false;
    for (const [name, provider] of this.providers) {
      try {
        provider.stop();
      } catch (e) {
        console.error(`[DiagnosticProviderManager] stop "${name}" failed:`, e);
      }
    }
  }

  refreshAll(): void {
    this.ensureNotDisposed();
    for (const [name, provider] of this.providers) {
      try {
        provider.refresh();
      } catch (e) {
        console.error(`[DiagnosticProviderManager] refresh "${name}" failed:`, e);
      }
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._started = false;
    for (const [, provider] of this.providers) {
      try {
        provider.dispose();
      } catch (e) {
        console.error(`[DiagnosticProviderManager] dispose failed:`, e);
      }
    }
    this.providers.clear();
  }

  private ensureNotDisposed(): void {
    if (this._disposed) {
      throw new Error('DiagnosticProviderManager is disposed');
    }
  }
}
