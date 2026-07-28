import { Disposable, Uri } from 'vscode';
import { IProblemProvider } from './IProblemProvider';

export abstract class BaseProblemProvider implements IProblemProvider {
  private _isRunning = false;
  private _isDisposed = false;
  private readonly _disposables: Disposable[] = [];

  get isRunning(): boolean {
    return this._isRunning;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  start(): void {
    this.ensureNotDisposed();
    if (this._isRunning) return;
    this._isRunning = true;
    this.onStart();
  }

  stop(): void {
    this.ensureNotDisposed();
    if (!this._isRunning) return;
    this._isRunning = false;
    this.onStop();
  }

  refresh(): void {
    this.ensureNotDisposed();
    this.onRefresh();
  }

  /**
   * Incremental scan of specific URIs.
   * Default implementation falls back to full refresh().
   * Subclasses should override for true incremental scanning.
   */
  refreshUris(_uris: readonly Uri[]): void {
    this.ensureNotDisposed();
    // Default: full refresh (subclasses should override for incremental)
    this.onRefresh();
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._isRunning = false;
    this.onDispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
  }

  protected onStart(): void {}
  protected onStop(): void {}
  protected onRefresh(): void {}
  protected onDispose(): void {}

  protected ensureNotDisposed(): void {
    if (this._isDisposed) {
      throw new Error('Provider is disposed');
    }
  }

  protected registerDisposable(d: Disposable): void {
    this._disposables.push(d);
  }
}
