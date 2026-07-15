import {
  Disposable,
  Event,
  WorkspaceFolder,
  workspace,
} from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { VSCodeDiagnosticProvider } from '../providers/VSCodeDiagnosticProvider';
import { FolderStatusManager } from '../folder/folderStatusManager';
import { DecorationEngine } from '../decoration/decorationEngine';
import { normalizeUriKey } from '../core/uriKey';

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

export class WorkspaceManager implements Disposable {
  private readonly delegate: WorkspaceDelegate;
  private readonly disposable: Disposable;

  constructor(
    private readonly store: ProblemStore,
    private readonly diagProvider: VSCodeDiagnosticProvider,
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

  getWorkspaceFolders(): readonly WorkspaceFolder[] {
    return this.delegate.workspaceFolders;
  }

  private handleChange(event: WorkspaceFoldersChangeEvent): void {
    for (let i = 0; i < event.removed.length; i++) {
      this.store.deleteByPrefix(normalizeUriKey(event.removed[i].uri));
    }

    if (event.added.length > 0) {
      this.diagProvider.fullScan();
      this.folderStatusManager.rebuildAll();
    }

    this.decorationEngine.refresh();
  }
}
