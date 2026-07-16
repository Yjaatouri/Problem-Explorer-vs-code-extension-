import { Event, Disposable, Uri } from 'vscode';
import { ProblemStore } from '../store/ProblemStore';

export interface DiagnosticProvider extends Disposable {
  readonly name: string;
  readonly store: ProblemStore;
  readonly scanning: boolean;
  readonly autoScan: boolean;
  readonly enabled: boolean;

  onDidUpdate: Event<Uri[]>;

  initialize(): void | Promise<void>;
  start(): void;
  stop(): void;
  refresh(): void | Promise<void>;

  /** Optional: called when provider is unregistered/stopped to release store ownership */
  releaseOwnership?(): void;
}
