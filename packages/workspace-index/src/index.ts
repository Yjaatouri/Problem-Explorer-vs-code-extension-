// @pe/workspace-index — the engine's knowledge of the filesystem.
// Owns ALL discovery: file list, mtimes, sizes, project roots. No `vscode`.

export {
  WorkspaceIndex,
  fileUriFromPath,
  createMemoryStorage,
  WORKSPACE_INDEX_STORAGE_KEY,
  DEFAULT_CONFIG_FILES,
} from './workspace-index.js';
export type { StorageBackend, WorkspaceIndexOptions } from './workspace-index.js';
