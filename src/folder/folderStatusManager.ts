import { Uri, WorkspaceFolder, workspace } from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState } from '../core/types';
import { normalizeUriKey } from '../core/uriKey';
import { aggregateStatuses } from './propagationStrategy';

/** Abstraction over VS Code workspace API for folder propagation logic */
export interface FolderWorkspace {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  readonly workspaceFolders: readonly WorkspaceFolder[];
}

const defaultWorkspace: FolderWorkspace = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
  // Must be a getter: workspace.workspaceFolders may be empty at module load
  // time and changes over the lifetime of the extension host.
  get workspaceFolders() {
    return workspace.workspaceFolders ?? [];
  },
};

/**
 * Manages folder-level diagnostic status by walking ancestor paths and
 * aggregating child statuses using worst-severity-wins logic.
 *
 * Maintains a parent→child index so that {@link updateAncestors} runs in
 * O(depth) rather than O(depth × cacheSize).
 */
export class FolderStatusManager {
  private readonly wf: FolderWorkspace;

  // parentKey → (childKey → childStatus)
  private readonly childIndex = new Map<string, Map<string, ProblemState>>();

  constructor(
    private readonly cache: ProblemCache,
    private readonly problemStore: ProblemStore,
    wf?: FolderWorkspace,
  ) {
    this.wf = wf ?? defaultWorkspace;
  }

  /**
   * Walk from a changed file up to the workspace root, updating the
   * parent–child index and recomputing each ancestor's aggregate status
   * from its direct children only (O(depth)).
   */
  updateAncestors(fileUri: Uri): Uri[] {
    const folder = this.wf.getWorkspaceFolder(fileUri);
    if (!folder) {
      return [];
    }

    const changed: Uri[] = [];
    let fileKey = normalizeUriKey(fileUri);
    const rootStr = normalizeUriKey(folder.uri);
    let current = Uri.joinPath(fileUri, '..');
    let currentStr = normalizeUriKey(current);

    // Walk from the file's parent up to (but not including) the workspace root
    while (currentStr !== rootStr) {
      const parentFolder = this.wf.getWorkspaceFolder(current);
      if (!parentFolder) {
        break;
      }
      const parentKey = currentStr;
      // The child that feeds into this parent — initially the file,
      // then the subfolder aggregate we just computed
      const childUri = Uri.parse(fileKey);

      let index = this.childIndex.get(parentKey);

      const childStatus = this.problemStore.get(childUri);
      if (childStatus) {
        if (!index) {
          index = new Map();
          this.childIndex.set(parentKey, index);
        }
        index.set(fileKey, childStatus);
      } else {
        index?.delete(fileKey);
      }

      // Recompute the folder aggregate from its index entries
      const status = this.aggregateFromIndex(parentKey);
      const parentUri = Uri.parse(parentKey);
      this.problemStore.set(parentUri, status);
      if (this.cache.setFolderAggregate(parentUri, status, parentFolder.uri)) {
        changed.push(parentUri);
      }

      // Walk up: this parent becomes the "child" for the next level
      fileKey = parentKey;
      const next = Uri.joinPath(current, '..');
      const nextStr = normalizeUriKey(next);
      if (nextStr === currentStr) {
        break;
      }
      current = next;
      currentStr = nextStr;
    }

    // Root folder
    let rootIndex = this.childIndex.get(rootStr);
    const rootChildUri = Uri.parse(fileKey);
    const rootChildStatus = this.problemStore.get(rootChildUri);
    if (rootChildStatus) {
      if (!rootIndex) {
        rootIndex = new Map();
        this.childIndex.set(rootStr, rootIndex);
      }
      rootIndex.set(fileKey, rootChildStatus);
    } else {
      rootIndex?.delete(fileKey);
    }

    const rootStatus = this.aggregateFromIndex(rootStr);
    this.problemStore.set(folder.uri, rootStatus);
    if (this.cache.setFolderAggregate(folder.uri, rootStatus, folder.uri)) {
      changed.push(folder.uri);
    }

    return changed;
  }

  /**
   * Remove every entry from the child-index whose key starts with the given
   * URI prefix (inclusive — removes the folder's own index entry too).
   * Call this before {@link updateAncestors} when moving a subtree so that
   * stale sub-folder index entries don't survive.
   */
  clearIndexPrefix(uri: Uri): void {
    const prefix = normalizeUriKey(uri);
    const prefixSlash = prefix + '/';
    for (const [key] of this.childIndex) {
      if (key === prefix || key.startsWith(prefixSlash)) {
        this.childIndex.delete(key);
      }
    }
  }

  /** Compute the aggregate status of all direct children from the index (O(directChildren)). */
  private aggregateFromIndex(parentKey: string): ProblemState {
    const index = this.childIndex.get(parentKey);
    if (!index || index.size === 0) {
      return { severity: 0, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0 };
    }
    return aggregateStatuses(Array.from(index.values()));
  }

  /**
   * Compute the aggregate status of all **file** children under a folder
   * by scanning the cache (used by `rebuildAll` cold-start).
   */
  recomputeFolderStatus(folderUri: Uri, _workspaceFolderUri: Uri): ProblemState {
    const folderStr = normalizeUriKey(folderUri);
    const prefix = folderStr + '/';

    const children: ProblemState[] = [];
    const all = this.problemStore.snapshot();
    for (const [key, status] of Object.entries(all)) {
      if (key !== folderStr && key.startsWith(prefix)) {
        children.push(status as ProblemState);
      }
    }
    return aggregateStatuses(children);
  }

  /** Walk all cached file entries and recompute every folder's aggregate status from scratch (cold-start). */
  rebuildAll(): Uri[] {
    const changed: Uri[] = [];

    this.childIndex.clear();

    const allEntries = this.problemStore.snapshot();

    for (const folder of this.wf.workspaceFolders) {
      const folderUri = folder.uri;
      const rootStr = normalizeUriKey(folderUri);
      const rootPrefix = rootStr + '/';

      const entries: Array<[string, ProblemState]> = [];
      for (const [key, status] of Object.entries(allEntries)) {
        if (key === rootStr || key.startsWith(rootPrefix)) {
          entries.push([key, status as ProblemState]);
        }
      }

      const folders = new Set<string>();
      for (const [uriStr] of entries) {
        if (uriStr === rootStr) continue;
        const uri = Uri.parse(uriStr);
        let current = Uri.joinPath(uri, '..');
        let currentStr = normalizeUriKey(current);
        if (currentStr === rootStr || currentStr === uriStr) continue;
        while (currentStr !== rootStr) {
          folders.add(currentStr);
          const next = Uri.joinPath(current, '..');
          const nextStr = normalizeUriKey(next);
          if (nextStr === currentStr) break;
          current = next;
          currentStr = nextStr;
        }
      }

      const sortedFolders = Array.from(folders).sort((a, b) => b.length - a.length);

      for (const dirStr of sortedFolders) {
        const dirUri = Uri.parse(dirStr);
        const status = this.recomputeFolderStatus(dirUri, folderUri);
        this.problemStore.set(dirUri, status);
        if (this.cache.setFolderAggregate(dirUri, status, folderUri)) {
          changed.push(dirUri);
        }
        const parentKey = dirStr;
        const parentPrefix = parentKey + '/';
        const childMap = new Map<string, ProblemState>();
        for (const [childStr, childStatus] of entries) {
          if (childStr.startsWith(parentPrefix) && childStr !== parentKey) {
            const rest = childStr.slice(parentPrefix.length);
            if (!rest.includes('/')) {
              childMap.set(childStr, childStatus);
            }
          }
        }
        for (const subDir of sortedFolders) {
          if (subDir === dirStr) continue;
          if (subDir.startsWith(parentPrefix)) {
            const rest = subDir.slice(parentPrefix.length);
            if (!rest.includes('/')) {
              const subStatus = this.problemStore.get(Uri.parse(subDir));
              if (subStatus) {
                childMap.set(subDir, subStatus);
              }
            }
          }
        }
        if (childMap.size > 0) {
          this.childIndex.set(parentKey, childMap);
        }
      }

      const rootStatus = this.recomputeFolderStatus(folderUri, folderUri);
      this.problemStore.set(folderUri, rootStatus);
      if (this.cache.setFolderAggregate(folderUri, rootStatus, folderUri)) {
        changed.push(folderUri);
      }
      const rootChildren = new Map<string, ProblemState>();
      for (const [childStr, childStatus] of entries) {
        if (childStr === rootStr) continue;
        if (childStr.startsWith(rootPrefix)) {
          const rest = childStr.slice(rootPrefix.length);
          if (!rest.includes('/')) {
            rootChildren.set(childStr, childStatus);
          }
        }
      }
      for (const subDir of sortedFolders) {
        if (subDir.startsWith(rootPrefix)) {
          const rest = subDir.slice(rootPrefix.length);
          if (!rest.includes('/')) {
            const subStatus = this.problemStore.get(Uri.parse(subDir));
            if (subStatus) {
              rootChildren.set(subDir, subStatus);
            }
          }
        }
      }
      if (rootChildren.size > 0) {
        this.childIndex.set(rootStr, rootChildren);
      }
    }

    return changed;
  }
}
