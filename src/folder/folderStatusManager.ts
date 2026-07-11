import { Uri, WorkspaceFolder, workspace } from 'vscode';
import { ProblemCache } from '../cache/cacheLayer';
import { ProblemStatus } from '../core/types';
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
  private readonly childIndex = new Map<string, Map<string, ProblemStatus>>();

  constructor(
    private readonly cache: ProblemCache,
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

      const childStatus = this.cache.get(childUri, parentFolder.uri);
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
    const rootChildStatus = this.cache.get(rootChildUri, folder.uri);
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
    if (this.cache.setFolderAggregate(folder.uri, rootStatus, folder.uri)) {
      changed.push(folder.uri);
    }

    return changed;
  }

  /** Compute the aggregate status of all direct children from the index (O(directChildren)). */
  private aggregateFromIndex(parentKey: string): ProblemStatus {
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
  recomputeFolderStatus(folderUri: Uri, workspaceFolderUri: Uri): ProblemStatus {
    const folderStr = normalizeUriKey(folderUri);
    const prefix = folderStr + '/';

    const children = this.cache
      .getFileEntries(workspaceFolderUri)
      .filter(([uri]) => {
        const str = normalizeUriKey(uri);
        return str !== folderStr && str.startsWith(prefix);
      })
      .map(([, status]) => status);

    return aggregateStatuses(children);
  }

  /** Walk all cached file entries and recompute every folder's aggregate status from scratch (cold-start). */
  rebuildAll(): Uri[] {
    const changed: Uri[] = [];

    // Rebuild the child index from scratch
    this.childIndex.clear();

    for (const folder of this.wf.workspaceFolders) {
      const folderUri = folder.uri;
      const rootStr = normalizeUriKey(folderUri);
      const entries = this.cache.getFileEntries(folderUri);

      // Discover all intermediate folders from file paths
      const folders = new Set<string>();
      for (const [uri] of entries) {
        const uriStr = normalizeUriKey(uri);
        if (uriStr === rootStr) {
          continue;
        }
        let current = Uri.joinPath(uri, '..');
        let currentStr = normalizeUriKey(current);
        if (currentStr === rootStr || currentStr === uriStr) {
          continue;
        }
        while (currentStr !== rootStr) {
          folders.add(currentStr);
          const next = Uri.joinPath(current, '..');
          const nextStr = normalizeUriKey(next);
          if (nextStr === currentStr) {
            break;
          }
          current = next;
          currentStr = nextStr;
        }
      }

      // Build index entries for each intermediate folder
      // Populate bottom-up so children are available when computing parents
      const sortedFolders = Array.from(folders).sort((a, b) => b.length - a.length);

      for (const dirStr of sortedFolders) {
        const dirUri = Uri.parse(dirStr);
        const status = this.recomputeFolderStatus(dirUri, folderUri);
        if (this.cache.setFolderAggregate(dirUri, status, folderUri)) {
          changed.push(dirUri);
        }
        // Populate this folder's children in the index
        const parentKey = dirStr;
        const parentPrefix = parentKey + '/';
        const childMap = new Map<string, ProblemStatus>();
        for (const [childUri, childStatus] of this.cache.getFileEntries(folderUri)) {
          const childStr = normalizeUriKey(childUri);
          if (childStr.startsWith(parentPrefix) && childStr !== parentKey) {
            const rest = childStr.slice(parentPrefix.length);
            // Only direct children (no '/ in the remainder)
            if (!rest.includes('/')) {
              childMap.set(childStr, childStatus);
            }
          }
        }
        // Also include subfolder aggregates as direct children
        for (const subDir of sortedFolders) {
          if (subDir === dirStr) continue;
          if (subDir.startsWith(parentPrefix)) {
            const rest = subDir.slice(parentPrefix.length);
            if (!rest.includes('/')) {
              const subStatus = this.cache.get(Uri.parse(subDir), folderUri);
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

      // Root folder
      const rootStatus = this.recomputeFolderStatus(folderUri, folderUri);
      if (this.cache.setFolderAggregate(folderUri, rootStatus, folderUri)) {
        changed.push(folderUri);
      }
      // Populate root's direct children in the index
      const rootPrefix = rootStr + '/';
      const rootChildren = new Map<string, ProblemStatus>();
      for (const [childUri, childStatus] of this.cache.getFileEntries(folderUri)) {
        const childStr = normalizeUriKey(childUri);
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
            const subStatus = this.cache.get(Uri.parse(subDir), folderUri);
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
