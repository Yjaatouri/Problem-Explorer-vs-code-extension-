import {
  Disposable,
  Event,
  WorkspaceFolder,
  workspace,
} from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { DiagnosticsManager } from '../diagnostics/diagnosticsManager';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { normalizeUriKey } from '../core/uriKey';

/** Abstraction over `workspace.workspaceFolders` and folder change events for testability */
export interface WorkspaceDelegate {
  readonly workspaceFolders: readonly WorkspaceFolder[];
  onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;
}

/** Shape of the VS Code workspace folder change event */
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

/** Tracks multi-root workspace folder changes and re-seeds cache/decoration state */
export class WorkspaceManager implements Disposable {
  private readonly delegate: WorkspaceDelegate;
  private readonly disposable: Disposable;

  constructor(
    private readonly store: ProblemStore,
    private readonly diagnosticsManager: DiagnosticsManager,
    private readonly folderStatusManager: FolderStatusManager,
    private readonly decorationEngine: DecorationEngine,
    delegate?: WorkspaceDelegate,
  ) {
    this.delegate = delegate ?? defaultDelegate;
    this.disposable = this.delegate.onDidChangeWorkspaceFolders((e) => {
      this.handleChange(e);
    });
  }

  dispose(): void {
    this.disposable.dispose();
  }

  /** Return the current list of workspace folders */
  getWorkspaceFolders(): readonly WorkspaceFolder[] {
    return this.delegate.workspaceFolders;
  }

  private handleChange(event: WorkspaceFoldersChangeEvent): void {
    for (let i = 0; i < event.removed.length; i++) {
      this.store.deleteByPrefix(normalizeUriKey(event.removed[i].uri));
    }

    if (event.added.length > 0) {
      this.diagnosticsManager.fullScan();
      this.folderStatusManager.rebuildAll();
    }

    this.decorationEngine.refresh();
  }
}
