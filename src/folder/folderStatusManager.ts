import { Uri, WorkspaceFolder, workspace } from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { ProblemStatus } from '../core/types';
import { aggregateStatuses } from './propagationStrategy';

/** Abstraction over VS Code workspace API for folder propagation logic */
export interface FolderWorkspace {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  readonly workspaceFolders: readonly WorkspaceFolder[];
}

const defaultWorkspace: FolderWorkspace = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
  workspaceFolders: workspace.workspaceFolders ?? [],
};

/**
 * Manages folder-level diagnostic status by walking ancestor paths and
 * aggregating child statuses using worst-severity-wins logic.
 */
export class FolderStatusManager {
  private readonly wf: FolderWorkspace;

  constructor(
    private readonly cache: ProblemCache,
    wf?: FolderWorkspace,
  ) {
    this.wf = wf ?? defaultWorkspace;
  }

  /**
   * Walk from a changed file up to the workspace root, recomputing each
   * ancestor's aggregate status. Returns the set of ancestor URIs whose
   * status actually changed.
   */
  updateAncestors(fileUri: Uri): Uri[] {
    const folder = this.wf.getWorkspaceFolder(fileUri);
    if (!folder) {
      return [];
    }

    const changed: Uri[] = [];
    const rootStr = folder.uri.toString();
    let current = Uri.joinPath(fileUri, '..');
    let currentStr = current.toString();

    while (currentStr !== rootStr) {
      const parentFolder = this.wf.getWorkspaceFolder(current);
      if (!parentFolder) {
        break;
      }
      const status = this.recomputeFolderStatus(current, parentFolder.uri);
      if (this.cache.set(current, status, parentFolder.uri)) {
        changed.push(current);
      }
      const next = Uri.joinPath(current, '..');
      const nextStr = next.toString();
      if (nextStr === currentStr) {
        break;
      }
      current = next;
      currentStr = nextStr;
    }

    const rootStatus = this.recomputeFolderStatus(folder.uri, folder.uri);
    if (this.cache.set(folder.uri, rootStatus, folder.uri)) {
      changed.push(folder.uri);
    }

    return changed;
  }

  /** Compute the aggregate status of all children directly under a given folder */
  recomputeFolderStatus(folderUri: Uri, workspaceFolderUri: Uri): ProblemStatus {
    const folderStr = folderUri.toString();
    const prefix = folderStr.endsWith('/') ? folderStr : folderStr + '/';

    const children = this.cache
      .getEntries(workspaceFolderUri)
      .filter(([uri]) => {
        const str = uri.toString();
        return str !== folderStr && str.startsWith(prefix);
      })
      .map(([, status]) => status);

    return aggregateStatuses(children);
  }

  /** Walk all cached entries and recompute every folder's aggregate status from scratch */
  rebuildAll(): Uri[] {
    const changed: Uri[] = [];

    for (const folder of this.wf.workspaceFolders) {
      const folderUri = folder.uri;
      const rootStr = folderUri.toString();
      const entries = this.cache.getEntries(folderUri);

      const folders = new Set<string>();
      for (const [uri] of entries) {
        const uriStr = uri.toString();
        if (uriStr === rootStr) {
          continue;
        }
        let current = Uri.joinPath(uri, '..');
        let currentStr = current.toString();
        if (currentStr === rootStr || currentStr === uriStr) {
          continue;
        }
        while (currentStr !== rootStr) {
          folders.add(currentStr);
          const next = Uri.joinPath(current, '..');
          const nextStr = next.toString();
          if (nextStr === currentStr) {
            break;
          }
          current = next;
          currentStr = nextStr;
        }
      }

      for (const dirStr of folders) {
        const dirUri = Uri.parse(dirStr);
        const status = this.recomputeFolderStatus(dirUri, folderUri);
        if (this.cache.set(dirUri, status, folderUri)) {
          changed.push(dirUri);
        }
      }

      const rootStatus = this.recomputeFolderStatus(folderUri, folderUri);
      if (this.cache.set(folderUri, rootStatus, folderUri)) {
        changed.push(folderUri);
      }
    }

    return changed;
  }
}
