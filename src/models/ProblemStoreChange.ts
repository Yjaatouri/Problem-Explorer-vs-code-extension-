import { Uri } from 'vscode';

export type ProblemStoreChange =
  | { kind: 'added'; uri: Uri }
  | { kind: 'updated'; uri: Uri }
  | { kind: 'removed'; uri: Uri }
  | { kind: 'cleared' }
  | { kind: 'batch' };
