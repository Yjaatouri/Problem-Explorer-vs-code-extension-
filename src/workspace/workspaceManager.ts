import {
  Event,
  WorkspaceFolder,
  workspace,
} from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { DiagnosticsManager } from '../diagnostics/diagnosticsManager';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';

export interface WorkspaceDelegate {
  readonly workspaceFolders: readonly WorkspaceFolder[];
  onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;
}

export interface WorkspaceFoldersChangeEvent {
  readonly added: readonly WorkspaceFolder[];
  readonly removed: readonly WorkspaceFolder[];
}

const defaultDelegate: WorkspaceDelegate = {
  get workspaceFolders() {
    return workspace.workspaceFolders ?? [];
  },
  onDidChangeWorkspaceFolders: (listener) =>
    workspace.onDidChangeWorkspaceFolders(listener),
};

export class WorkspaceManager {
  private readonly delegate: WorkspaceDelegate;

  constructor(
    private readonly cache: ProblemCache,
    private readonly diagnosticsManager: DiagnosticsManager,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly decorationEngine: DecorationEngine,
    delegate?: WorkspaceDelegate,
  ) {
    this.delegate = delegate ?? defaultDelegate;
    this.delegate.onDidChangeWorkspaceFolders((e) => {
      this.handleChange(e);
    });
  }

  getWorkspaceFolders(): readonly WorkspaceFolder[] {
    return this.delegate.workspaceFolders;
  }

  private handleChange(event: WorkspaceFoldersChangeEvent): void {
    for (let i = 0; i < event.removed.length; i++) {
      this.cache.clearFolder(event.removed[i].uri);
    }

    if (event.added.length > 0) {
      this.diagnosticsManager.fullScan();
      this.folderStatusManager.rebuildAll();
    }

    this.decorationEngine.refresh();
  }
}
