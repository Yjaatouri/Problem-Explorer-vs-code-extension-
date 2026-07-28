import { Disposable, Uri } from 'vscode';

export interface IProblemProvider extends Disposable {
  start(): void;
  stop(): void;
  refresh(): void;
  /** Optional: incremental scan of specific files */
  refreshUris?(uris: readonly Uri[]): void;
}
