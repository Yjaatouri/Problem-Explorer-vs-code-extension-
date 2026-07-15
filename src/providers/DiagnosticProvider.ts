import { Event, Disposable } from 'vscode';
import { ProblemStore } from '../store/ProblemStore';

export interface DiagnosticProvider extends Disposable {
  readonly name: string;
  readonly store: ProblemStore;

  onDidUpdate: Event<void>;

  initialize(): void | Promise<void>;
  start(): void;
  stop(): void;
  refresh(): void;
}
