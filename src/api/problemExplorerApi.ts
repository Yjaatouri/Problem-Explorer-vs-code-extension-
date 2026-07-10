import { Event, EventEmitter, Uri, WorkspaceFolder, workspace } from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { ProblemStatus } from '../core/types';

/** Abstraction over `workspace.getWorkspaceFolder` for testability */
export interface WorkspaceFolderDelegate {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
}

const defaultDelegate: WorkspaceFolderDelegate = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
};

export interface ProblemExplorerAPI {
  getProblemStatus(uri: Uri): ProblemStatus | undefined;
  readonly onDidChangeProblemStatus: Event<ProblemStatusChangeEvent>;
}

export interface ProblemStatusChangeEvent {
  readonly uri: Uri;
  readonly status: ProblemStatus | undefined;
}

/** Manages the public API exposed by `activate()` for other extensions */
export class ApiManager implements ProblemExplorerAPI {
  private readonly _onDidChangeProblemStatus = new EventEmitter<ProblemStatusChangeEvent>();
  readonly onDidChangeProblemStatus: Event<ProblemStatusChangeEvent> =
    this._onDidChangeProblemStatus.event;
  private readonly wf: WorkspaceFolderDelegate;

  constructor(
    private readonly cache: ProblemCache,
    wf?: WorkspaceFolderDelegate,
  ) {
    this.wf = wf ?? defaultDelegate;
  }

  /** Look up the cached problem status for a URI. Returns `undefined` if not cached or not in a workspace folder. */
  getProblemStatus(uri: Uri): ProblemStatus | undefined {
    const folder = this.wf.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return this.cache.get(uri, folder.uri);
  }

  /** Called by extension.ts when diagnostics change. Reads status from cache and emits the event. */
  notifyChanged(uri: Uri, folderUri: Uri): void {
    const status = this.cache.get(uri, folderUri);
    this._onDidChangeProblemStatus.fire({ uri, status });
  }
}
