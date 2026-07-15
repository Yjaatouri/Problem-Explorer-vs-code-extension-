import { Event, EventEmitter, Uri } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { ProblemStore } from '../store/ProblemStore';

export class EslintDiagnosticProvider implements DiagnosticProvider {
  readonly name = 'eslint';
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  private _disposed = false;

  get store(): ProblemStore {
    return this._store;
  }

  constructor(store: ProblemStore) {
    this._store = store;
  }

  initialize(): void | Promise<void> {
    if (this._disposed) return;
  }

  start(): void {
    if (this._disposed) return;
  }

  stop(): void {
    if (this._disposed) return;
  }

  refresh(): void {
    if (this._disposed) return;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._onDidUpdate.dispose();
  }
}
