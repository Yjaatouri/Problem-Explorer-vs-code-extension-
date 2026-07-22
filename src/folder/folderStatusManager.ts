import { Uri, WorkspaceFolder, workspace } from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState } from '../core/types';
import { normalizeUriKey, getParentKey } from '../core/uriKey';
import { aggregateStatuses } from './propagationStrategy';


export interface FolderWorkspace {
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
  readonly workspaceFolders: readonly WorkspaceFolder[];
}

const defaultWorkspace: FolderWorkspace = {
  getWorkspaceFolder: (uri) => workspace.getWorkspaceFolder(uri),
  get workspaceFolders() {
    return workspace.workspaceFolders ?? [];
  },
};

export class FolderStatusManager {
  private readonly wf: FolderWorkspace;

  // parentKey → (childKey → childStatus)
  private readonly childIndex = new Map<string, Map<string, ProblemState>>();

  /** Number of parent entries in the child index (exposed for monitoring) */
  get childIndexSize(): number { return this.childIndex.size; }

  constructor(
    private readonly problemStore: ProblemStore,
    wf?: FolderWorkspace,
  ) {
    this.wf = wf ?? defaultWorkspace;
  }

  /**
   * Walk from a changed file up to the workspace root, updating the
   * parent–child index and recomputing each ancestor's aggregate status
   * from its direct children only (O(depth)).
   *
   * Uses string-based parent key extraction (getParentKey) instead of
   * Uri.parse/Uri.joinPath to avoid per-level object allocations.
   */
  updateAncestors(fileUri: Uri): Uri[] {
    const folder = this.wf.getWorkspaceFolder(fileUri);
    if (!folder) {
      return [];
    }
    const changed: Uri[] = [];
    let childKey = normalizeUriKey(fileUri);
    const rootStr = normalizeUriKey(folder.uri);
    const rootStrLower = rootStr.toLowerCase();
    let parentKey = getParentKey(childKey);

    // Walk from the file's parent up to (but not including) the workspace root
    while (parentKey !== childKey && (process.platform === 'win32' ? parentKey.toLowerCase() !== rootStrLower : parentKey !== rootStr)) {
      let index = this.childIndex.get(parentKey);

      const childStatus = this.problemStore.get(Uri.parse(childKey));
      if (childStatus) {
        if (!index) {
          index = new Map();
          this.childIndex.set(parentKey, index);
        }
        index.set(childKey, childStatus);
      } else {
        index?.delete(childKey);
      }

      if (index && index.size > 0) {
        const status = this.aggregateFromIndex(parentKey);
        const parentUri = Uri.parse(parentKey);
        if (this.problemStore.setFolderAggregate(parentUri, status)) {
          changed.push(parentUri);
        } else {
        }
      } else if (this.problemStore.isFolderAggregate(Uri.parse(parentKey))) {
        this.problemStore.delete(Uri.parse(parentKey));
        changed.push(Uri.parse(parentKey));
      }

      // Walk up
      childKey = parentKey;
      parentKey = getParentKey(childKey);
    }

    // Root folder
    let rootIndex = this.childIndex.get(rootStr);
    const rootChildStatus = this.problemStore.get(Uri.parse(childKey));
    if (rootChildStatus) {
      if (!rootIndex) {
        rootIndex = new Map();
        this.childIndex.set(rootStr, rootIndex);
      }
      rootIndex.set(childKey, rootChildStatus);
    } else {
      rootIndex?.delete(childKey);
    }

    const rootUri = folder.uri;
    if (rootIndex && rootIndex.size > 0) {
      const rootStatus = this.aggregateFromIndex(rootStr);
      if (this.problemStore.setFolderAggregate(rootUri, rootStatus)) {
        changed.push(rootUri);
      } else {
      }
    } else if (this.problemStore.isFolderAggregate(rootUri)) {
      this.problemStore.delete(rootUri);
      changed.push(rootUri);
    }

    return changed;
  }

  clearIndexPrefix(uri: Uri): void {
    const prefix = normalizeUriKey(uri);
    const prefixSlash = prefix + '/';
    for (const [key] of this.childIndex) {
      if (key === prefix || key.startsWith(prefixSlash)) {
        this.childIndex.delete(key);
      }
    }
  }

  private aggregateFromIndex(parentKey: string): ProblemState {
    const index = this.childIndex.get(parentKey);
    if (!index || index.size === 0) {
      return { severity: 0, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0 };
    }
    return aggregateStatuses(Array.from(index.values()));
  }

  /**
   * Compute aggregated status for a single folder by iterating store file
   * entries via `forEachFileEntry` (no snapshot copy).
   */
  recomputeFolderStatus(folderUri: Uri): ProblemState {
    const folderStr = normalizeUriKey(folderUri);
    const prefix = folderStr + '/';

    const children: ProblemState[] = [];
    this.problemStore.forEachFileEntry((key, status) => {
      if (key !== folderStr && key.startsWith(prefix)) {
        children.push(status);
      }
    });
    return aggregateStatuses(children);
  }

  /**
   * Walk all cached file entries and recompute every folder's aggregate
   * status from scratch (cold-start).
   *
   * Uses forEachEntry to avoid snapshot() copy+freeze overhead, and uses
   * string-based parent extraction instead of Uri operations.
   */
  rebuildAll(): Uri[] {
    const changed: Uri[] = [];
    this.childIndex.clear();

    const allEntries: Array<[string, ProblemState, boolean]> = [];
    this.problemStore.forEachEntry((key, state, isFolder) => {
      allEntries.push([key, state, isFolder]);
    });

    for (const folder of this.wf.workspaceFolders) {
      const rootStr = normalizeUriKey(folder.uri);
      const rootPrefix = rootStr + '/';
      const rootStrLower = rootStr.toLowerCase();
      const rootPrefixLower = rootPrefix.toLowerCase();

      // Filter entries for this workspace folder
      const entries: Array<[string, ProblemState, boolean]> = [];
      for (const entry of allEntries) {
        const key = entry[0];
        if (process.platform === 'win32') {
          if (key.toLowerCase() === rootStrLower || key.toLowerCase().startsWith(rootPrefixLower)) {
            entries.push(entry);
          }
        } else {
          if (key === rootStr || key.startsWith(rootPrefix)) {
            entries.push(entry);
          }
        }
      }

      // Find all intermediate directories (using getParentKey, no Uri allocations)
      const folders = new Set<string>();
      for (const [uriStr] of entries) {
        if (uriStr === rootStr) continue;
        let dir = getParentKey(uriStr);
        while (dir !== rootStr && dir !== uriStr) {
          folders.add(dir);
          const next = getParentKey(dir);
          if (next === dir) break;
          dir = next;
        }
      }

      const sortedFolders = Array.from(folders).sort((a, b) => b.length - a.length);

      for (const dirStr of sortedFolders) {
        const dirUri = Uri.parse(dirStr);
        const status = this.recomputeFolderStatus(dirUri);
        if (this.problemStore.setFolderAggregate(dirUri, status)) {
          changed.push(dirUri);
        }

        const parentPrefix = dirStr + '/';
        const childMap = new Map<string, ProblemState>();
        for (const [childStr, childStatus] of entries) {
          if (childStr.startsWith(parentPrefix) && childStr !== dirStr) {
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
          this.childIndex.set(dirStr, childMap);
        }
      }

      // Root folder
      const rootStatus = this.recomputeFolderStatus(folder.uri);
      if (this.problemStore.setFolderAggregate(folder.uri, rootStatus)) {
        changed.push(folder.uri);
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
