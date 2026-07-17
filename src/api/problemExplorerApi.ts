import { Disposable, Event, EventEmitter, Uri, WorkspaceFolder, workspace } from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState } from '../core/types';

/** Abstraction over `workspace.getWorkspaceFolder` for testability */
export interface WorkspaceFolderDelegate {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
}

const defaultDelegate: WorkspaceFolderDelegate = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
};

export interface ProblemExplorerAPI {
  getProblemState(uri: Uri): ProblemState | undefined;
  readonly onDidChangeProblemState: Event<ProblemStateChangeEvent>;
}

export interface ProblemStateChangeEvent {
  readonly uri: Uri;
  readonly status: ProblemState | undefined;
}

/** Manages the public API exposed by `activate()` for other extensions */
export class ApiManager implements ProblemExplorerAPI, Disposable {
  private readonly _onDidChangeProblemState = new EventEmitter<ProblemStateChangeEvent>();
  readonly onDidChangeProblemState: Event<ProblemStateChangeEvent> =
    this._onDidChangeProblemState.event;
  private readonly wf: WorkspaceFolderDelegate;

  constructor(
    private readonly problemStore: ProblemStore,
    wf?: WorkspaceFolderDelegate,
  ) {
    this.wf = wf ?? defaultDelegate;
  }

  /** Look up the cached problem status for a URI. Returns `undefined` if not cached or not in a workspace folder. */
  getProblemState(uri: Uri): ProblemState | undefined {
    const folder = this.wf.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return this.problemStore.get(uri);
  }

  /** Called by extension.ts when diagnostics change. Reads status from ProblemStore and emits the event. */
  notifyChanged(uri: Uri, _folderUri: Uri): void {
    const ts = Date.now();
    const status = this.problemStore.get(uri);
    console.log(`[AUDIT:${ts}] API.notifyChanged() uri=${uri.fsPath.split('\\').pop() || uri.fsPath} storeHit=${!!status} sev=${status?.severity ?? 'none'}`);
    this._onDidChangeProblemState.fire({ uri, status });
    console.log(`[AUDIT:${Date.now()}] API.notifyChanged() → _onDidChangeProblemState fired elapsed=${Date.now() - ts}ms`);
  }

  dispose(): void {
    this._onDidChangeProblemState.dispose();
  }
}
