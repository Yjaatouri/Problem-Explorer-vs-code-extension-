// WorkspaceIndex — the engine's knowledge of the filesystem.
//
// Owns ALL discovery: file list, mtimes, sizes, project roots. Providers never
// walk the filesystem; they receive URI sets from the engine.
//
// Persistence contract (§10.1): stores ONLY mtime, size, lastScanned,
// owning provider, project root — under the fixed prefix
// `problemExplorer.workspaceIndex.v1`. Never content hashes, diagnostics,
// or scan results.
//
// Editor-agnostic: uses node:fs directly; consumers supply a StorageBackend
// (VS Code Memento, plain files, in-memory).

import {
  type ConfigType,
  type FileChange,
  type FileChangeEvent,
  type FileEntry,
  normalizeUriKey,
  TypedEventEmitter,
  type Uri,
  WorkspaceIndexError,
} from '@pe/core';
import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/** Pluggable persistence backend. Synchronous contract (VS Code memento can wrap). */
export interface StorageBackend {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** Persistence key — fixed prefix (§10.1). Do not change without a migration. */
export const WORKSPACE_INDEX_STORAGE_KEY = 'problemExplorer.workspaceIndex.v1';

const DEFAULT_EXCLUDED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  '__pycache__',
];

/** Known config-file names per ConfigType, used for project-root discovery. */
export const DEFAULT_CONFIG_FILES: Readonly<Record<ConfigType, readonly string[]>> = {
  typescript: ['tsconfig.json'],
  'typescript-react': ['tsconfig.json'],
  javascript: ['package.json', 'jsconfig.json'],
  python: [
    'pyproject.toml',
    'ruff.toml',
    '.ruff.toml',
    'setup.py',
    'setup.cfg',
    'tox.ini',
    'requirements.txt',
  ],
  rust: ['Cargo.toml'],
  go: ['go.mod'],
  php: ['composer.json'],
  csharp: ['*.csproj'],
  java: ['pom.xml', 'build.gradle'],
  cpp: ['CMakeLists.txt', 'meson.build', 'Makefile'],
};

export interface WorkspaceIndexOptions {
  /** Workspace roots (usually one). */
  readonly roots: readonly Uri[];
  /** Persistence backend. Defaults to in-memory (nothing survives a restart). */
  readonly storage?: StorageBackend;
  /** Additional directory names to skip during discovery (besides defaults). */
  readonly excludeDirectories?: readonly string[];
  /** Config-file names per type for project-root discovery. */
  readonly configFiles?: Readonly<Partial<Record<ConfigType, readonly string[]>>>;
  /** Clock for timestamps; injectable for tests. */
  readonly now?: () => number;
}

/** What a persisted entry records — nothing but metadata (§10.1). */
interface PersistedEntry {
  size: number;
  modifiedMs: number;
  lastScannedMs?: number;
  owningProviderId?: string;
  /** Project root as a filesystem path (restored via fileUriFromPath). */
  projectRoot: string;
}

interface PersistedPayload {
  version: 1;
  entries: Record<string, PersistedEntry>;
}

/** Structural Uri over a filesystem path (used by the index and consumers). */
export function fileUriFromPath(fsPath: string): Uri {
  const normalized = fsPath.replace(/\\/g, '/');
  const withScheme = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encodedPath = withScheme
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
    .replace(/^(\/[A-Za-z])(%3A|%3a|:)/, (_m, drive: string) => drive.toLowerCase() + '%3A');
  const uriString = `file://${encodedPath}`;
  const uri: Uri = {
    scheme: 'file',
    authority: '',
    path: withScheme,
    fsPath,
    toString: () => uriString,
    with: (change: { path?: string }) => fileUriFromPath(change.path ?? fsPath),
  };
  return uri;
}

export class WorkspaceIndex {
  private readonly roots: readonly Uri[];
  private readonly storage: StorageBackend;
  private readonly excludedDirectories: ReadonlySet<string>;
  private readonly configFiles: Readonly<Partial<Record<ConfigType, readonly string[]>>>;
  private readonly now: () => number;
  private readonly fileChangeEmitter = new TypedEventEmitter<FileChangeEvent>();
  private files = new Map<string, FileEntry>();
  private persistedEntries = new Map<string, PersistedEntry>();

  constructor(options: WorkspaceIndexOptions) {
    if (options.roots.length === 0) {
      throw new WorkspaceIndexError('at least one root is required', 'no-roots');
    }
    this.roots = options.roots;
    this.storage = options.storage ?? createMemoryStorage();
    this.excludedDirectories = new Set([
      ...DEFAULT_EXCLUDED_DIRECTORIES,
      ...(options.excludeDirectories ?? []),
    ]);
    this.configFiles = { ...DEFAULT_CONFIG_FILES, ...options.configFiles };
    this.now = options.now ?? Date.now;
  }

  /** Event: file additions / changes / removals detected during a rebuild. */
  readonly onDidChangeFiles = this.fileChangeEmitter.on.bind(this.fileChangeEmitter);

  /** Full file list (frozen snapshot). */
  listFiles(): readonly FileEntry[] {
    return Object.freeze([...this.files.values()]);
  }

  /** Files matching an extension ('.ts', '.py', …). */
  listFilesForExtension(extension: string): readonly FileEntry[] {
    const needle = extension.startsWith('.')
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    return Object.freeze([...this.files.values()].filter((entry) => entry.extension === needle));
  }

  getFile(uri: Uri): FileEntry | undefined {
    return this.files.get(normalizeUriKey(uri));
  }

  /** Nearest project root (dir containing a known config file), or null if not indexed. */
  getProjectRoot(uri: Uri): Uri | null {
    const entry = this.files.get(normalizeUriKey(uri));
    return entry?.projectRoot ?? null;
  }

  /** Whether a path falls under a watched root and is not excluded. */
  isWatched(path: string): boolean {
    let normalized = path.replace(/\\/g, '/');
    for (const root of this.roots) {
      let rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
      if (process.platform === 'win32') {
        normalized = normalized.toLowerCase();
        rootPath = rootPath.toLowerCase();
      }
      if (!(normalized === rootPath || normalized.startsWith(rootPath + '/'))) {
        continue;
      }
      const rel = relative(rootPath, normalized).split(/[\\/]/);
      if (rel.some((segment) => this.excludedDirectories.has(segment))) {
        return false;
      }
      return true;
    }
    return false;
  }

  /** Load persisted metadata from storage (called at construction; idempotent). */
  load(): void {
    const raw = this.storage.get(WORKSPACE_INDEX_STORAGE_KEY);
    if (raw === undefined) {
      this.persistedEntries = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedPayload;
      if (parsed.version !== 1 || !parsed.entries) {
        throw new Error(`unsupported persisted payload version`);
      }
      this.persistedEntries = new Map(Object.entries(parsed.entries));
    } catch (error) {
      // Corrupt or unknown metadata must never crash the engine — start fresh.
      this.persistedEntries = new Map();
      console.warn('[WorkspaceIndex] ignoring unreadable persisted metadata:', error);
    }
  }

  /**
   * Re-walk the workspace and diff against the previous state (and persisted
   * metadata). Emits onDidChangeFiles with add / change / remove batches.
   */
  rebuildDiagnostics(): void {
    const changes: FileChange[] = [];
    const fresh = new Map<string, FileEntry>();
    for (const root of this.roots) {
      this.walk(root.fsPath, root, undefined, fresh, changes);
    }
    // files that disappeared
    for (const key of this.files.keys()) {
      if (!fresh.has(key)) {
        const uri = this.files.get(key)!.uri;
        changes.push({ kind: 'remove', uri });
      }
    }
    this.files = fresh;
    this.fileChangeEmitter.fire({ changes });
  }

  /** Record that a scan covered a file. Updates lastScanned + owning provider. */
  markScanned(uri: Uri, providerId: string, atMs: number = this.now()): void {
    const key = normalizeUriKey(uri);
    const entry = this.files.get(key);
    if (!entry) {
      return;
    }
    this.files.set(key, { ...entry, owningProviderId: providerId, lastScannedMs: atMs });
  }

  /** Persist metadata under `problemExplorer.workspaceIndex.v1` (§10.1). */
  persist(): void {
    const entries: Record<string, PersistedEntry> = {};
    for (const [key, entry] of this.files) {
      entries[key] = {
        size: entry.size,
        modifiedMs: entry.modifiedMs,
        lastScannedMs: entry.lastScannedMs,
        owningProviderId: entry.owningProviderId,
        projectRoot: entry.projectRoot.fsPath,
      };
    }
    const payload: PersistedPayload = { version: 1, entries };
    this.storage.set(WORKSPACE_INDEX_STORAGE_KEY, JSON.stringify(payload));
  }

  private walk(
    dirPath: string,
    projectRoot: Uri,
    childProjectRoot: Uri | undefined,
    fresh: Map<string, FileEntry>,
    changes: FileChange[],
  ): void {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip, never crash the engine
    }
    let projectRootHere = childProjectRoot ?? projectRoot;
    if (this.directoryIsProjectRoot(dirPath)) {
      projectRootHere = fileUriFromPath(dirPath);
    }
    for (const dirent of entries) {
      if (dirent.isDirectory()) {
        if (dirent.name.startsWith('.') || this.excludedDirectories.has(dirent.name)) {
          continue;
        }
        this.walk(join(dirPath, dirent.name), projectRootHere, undefined, fresh, changes);
      } else if (dirent.isFile()) {
        this.indexFile(join(dirPath, dirent.name), projectRootHere, fresh, changes);
      }
    }
  }

  private directoryIsProjectRoot(dirPath: string): boolean {
    for (const names of Object.values(this.configFiles)) {
      if (
        names?.some((name) => {
          if (name.includes('*')) {
            const pattern = name.slice(1).toLowerCase();
            try {
              return readdirSync(dirPath).some((f) => f.toLowerCase().endsWith(pattern));
            } catch {
              return false;
            }
          }
          try {
            statSync(join(dirPath, name)).isFile();
            return true;
          } catch {
            return false;
          }
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private indexFile(
    filePath: string,
    projectRoot: Uri,
    fresh: Map<string, FileEntry>,
    changes: FileChange[],
  ): void {
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      return; // raced with deletion — skip
    }
    const uri = fileUriFromPath(filePath);
    const key = normalizeUriKey(uri);
    const extension = extname(uri.path).toLowerCase();
    const persisted = this.persistedEntries.get(key);
    const previous = this.files.get(key);
    const unchangedFromMemory =
      previous !== undefined &&
      previous.size === stats.size &&
      previous.modifiedMs === stats.mtimeMs;
    const unchangedFromPersisted =
      persisted !== undefined &&
      persisted.size === stats.size &&
      persisted.modifiedMs === stats.mtimeMs;
    if (unchangedFromMemory) {
      fresh.set(key, previous);
      return;
    } else if (unchangedFromPersisted && persisted !== undefined) {
      fresh.set(key, {
        uri,
        extension,
        size: stats.size,
        modifiedMs: stats.mtimeMs,
        projectRoot: fileUriFromPath(persisted.projectRoot),
        owningProviderId: persisted.owningProviderId,
        lastScannedMs: persisted.lastScannedMs,
      });
      return;
    }
    fresh.set(key, {
      uri,
      extension,
      size: stats.size,
      modifiedMs: stats.mtimeMs,
      projectRoot,
    });
    changes.push({
      kind: previous === undefined ? 'add' : 'change',
      uri,
      size: stats.size,
      modifiedMs: stats.mtimeMs,
    });
  }
}

/** In-memory storage — the default backend (nothing survives a restart). */
export function createMemoryStorage(): StorageBackend {
  const data = new Map<string, string>();
  return {
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
    },
  };
}
