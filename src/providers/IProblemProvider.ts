import { Disposable } from 'vscode';

export interface IProblemProvider extends Disposable {
  start(): void;
  stop(): void;
  refresh(): void;
}
