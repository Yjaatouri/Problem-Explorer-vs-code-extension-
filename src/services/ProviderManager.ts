import { IProblemProvider } from '../providers/IProblemProvider';

export class ProviderManager {
  private readonly providers = new Map<string, IProblemProvider>();
  private _isDisposed = false;

  register(name: string, provider: IProblemProvider): void {
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
    this.providers.delete(name);
    provider.dispose();
    return true;
  }

  get(name: string): IProblemProvider | undefined {
    return this.providers.get(name);
  }

  startAll(): void {
    this.ensureNotDisposed();
    for (const [, provider] of this.providers) {
      provider.start();
    }
  }

  stopAll(): void {
    this.ensureNotDisposed();
    for (const [, provider] of this.providers) {
      provider.stop();
    }
  }

  refreshAll(): void {
    this.ensureNotDisposed();
    for (const [, provider] of this.providers) {
      provider.refresh();
    }
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    for (const [, provider] of this.providers) {
      provider.dispose();
    }
    this.providers.clear();
  }

  get size(): number {
    return this.providers.size;
  }

  private ensureNotDisposed(): void {
    if (this._isDisposed) {
      throw new Error('ProviderManager is disposed');
    }
  }
}
