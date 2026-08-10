import {
  createMemoryStorage,
  fileUriFromPath,
  WorkspaceIndex,
  WORKSPACE_INDEX_STORAGE_KEY,
} from '../src/workspace-index.js';
import { normalizeUriKey } from '@pe/core';
import type { FileChange } from '@pe/core';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pe-workspace-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'src', 'nested'));
  mkdirSync(join(dir, 'node_modules'));
  mkdirSync(join(dir, '.hidden'));
  writeFileSync(join(dir, 'tsconfig.json'), '{}');
  writeFileSync(join(dir, 'src', 'app.ts'), 'const x: number = "nope";');
  writeFileSync(join(dir, 'src', 'nested', 'deep.py'), 'print("hi")');
  writeFileSync(join(dir, 'node_modules', 'skip.ts'), 'ignored');
  writeFileSync(join(dir, '.hidden', 'hidden.ts'), 'ignored');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setMtime(filePath: string, atMs: number): void {
  const time = new Date(atMs);
  utimesSync(filePath, time, time);
}

describe('fileUriFromPath', () => {
  it('produces canonical file URIs with lowercased drive letters', () => {
    const uri = fileUriFromPath('C:\\Users\\Jbilo\\Proj\\src\\App.ts');
    expect(uri.toString()).toBe('file:///c%3A/Users/Jbilo/Proj/src/App.ts');
    expect(uri.scheme).toBe('file');
    expect(uri.fsPath).toBe('C:\\Users\\Jbilo\\Proj\\src\\App.ts');
  });

  it('handles posix paths', () => {
    const uri = fileUriFromPath('/home/user/proj/app.ts');
    expect(uri.toString()).toBe('file:///home/user/proj/app.ts');
  });
});

describe('WorkspaceIndex', () => {
  it('discovers files and skips excluded directories', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    const files = index.listFiles();
    expect(files).toHaveLength(3);
    const names = files
      .map((entry) => relative(dir, entry.uri.fsPath).replaceAll('\\', '/'))
      .sort();
    expect(names).toEqual(['src/app.ts', 'src/nested/deep.py', 'tsconfig.json']);
    const app = files.find((entry) => entry.uri.fsPath.endsWith('app.ts'));
    expect(app?.extension).toBe('.ts');
    expect(app?.size).toBeGreaterThan(0);
  });

  it('emits add events on first rebuild', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    const changes: FileChange[] = [];
    index.onDidChangeFiles((event) => changes.push(...event.changes));
    index.rebuildDiagnostics();
    expect(changes.every((change) => change.kind === 'add')).toBe(true);
    expect(changes).toHaveLength(3);
  });

  it('emits nothing when nothing changed', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    const changes: FileChange[] = [];
    index.onDidChangeFiles((event) => changes.push(...event.changes));
    index.rebuildDiagnostics();
    expect(changes).toHaveLength(0);
  });

  it('emits change events when a file is modified', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    const target = join(dir, 'src', 'app.ts');
    writeFileSync(target, 'const x: number = 42;');
    setMtime(target, statSync(target).mtimeMs + 10_000);
    const changes: FileChange[] = [];
    index.onDidChangeFiles((event) => changes.push(...event.changes));
    index.rebuildDiagnostics();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('change');
    expect(changes[0]?.uri.fsPath).toBe(target);
  });

  it('emits remove events when a file disappears', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    rmSync(join(dir, 'src', 'app.ts'));
    const changes: FileChange[] = [];
    index.onDidChangeFiles((event) => changes.push(...event.changes));
    index.rebuildDiagnostics();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('remove');
  });

  it('finds the nearest project root by config file', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    const root = index.getProjectRoot(fileUriFromPath(join(dir, 'src', 'app.ts')));
    expect(root?.fsPath).toBe(dir);
  });

  it('falls back to the workspace root when no config file exists', () => {
    const dir = makeWorkspace();
    rmSync(join(dir, 'tsconfig.json'));
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    const root = index.getProjectRoot(fileUriFromPath(join(dir, 'src', 'nested', 'deep.py')));
    expect(root?.fsPath).toBe(dir);
  });

  it('isWatched covers roots and excludes exclusions', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    expect(index.isWatched(join(dir, 'src', 'app.ts'))).toBe(true);
    expect(index.isWatched(join(dir, 'node_modules', 'skip.ts'))).toBe(false);
    expect(index.isWatched(join(dir, '..', 'elsewhere.ts'))).toBe(false);
  });

  it('supports extra excluded directories', () => {
    const dir = makeWorkspace();
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build', 'generated.ts'), 'generated');
    const index = new WorkspaceIndex({
      roots: [fileUriFromPath(dir)],
      excludeDirectories: ['build'],
    });
    index.rebuildDiagnostics();
    expect(index.listFiles().some((entry) => entry.uri.fsPath.includes('build'))).toBe(false);
  });

  it('persists and restores metadata under the fixed key', () => {
    const dir = makeWorkspace();
    const storage = createMemoryStorage();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)], storage });
    index.rebuildDiagnostics();
    const appUri = fileUriFromPath(join(dir, 'src', 'app.ts'));
    index.markScanned(appUri, 'tsc', 12345);
    index.persist();

    const raw = storage.get(WORKSPACE_INDEX_STORAGE_KEY);
    expect(raw).toBeDefined();
    const payload = JSON.parse(raw!) as { version: number; entries: Record<string, unknown> };
    expect(payload.version).toBe(1);
    expect(Object.keys(payload.entries)).toHaveLength(3);

    const restored = new WorkspaceIndex({ roots: [fileUriFromPath(dir)], storage });
    restored.load();
    const changes: FileChange[] = [];
    restored.onDidChangeFiles((event) => changes.push(...event.changes));
    restored.rebuildDiagnostics();
    expect(changes).toHaveLength(0);
    const entry = restored.getFile(appUri);
    expect(entry?.lastScannedMs).toBe(12345);
    expect(entry?.owningProviderId).toBe('tsc');
    expect(normalizeUriKey(entry!.projectRoot)).toBe(normalizeUriKey(fileUriFromPath(dir)));
  });

  it('ignores corrupt persisted metadata instead of crashing', () => {
    const dir = makeWorkspace();
    const storage = createMemoryStorage();
    storage.set(WORKSPACE_INDEX_STORAGE_KEY, 'not-json{');
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)], storage });
    index.load();
    index.rebuildDiagnostics();
    expect(index.listFiles()).toHaveLength(3);
  });

  it('listFilesForExtension filters by extension', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    expect(index.listFilesForExtension('.ts')).toHaveLength(1);
    expect(index.listFilesForExtension('py')).toHaveLength(1);
    expect(index.listFilesForExtension('.rs')).toHaveLength(0);
  });

  it('markScanned on an unknown file is a no-op', () => {
    const dir = makeWorkspace();
    const index = new WorkspaceIndex({ roots: [fileUriFromPath(dir)] });
    index.rebuildDiagnostics();
    expect(() => index.markScanned(fileUriFromPath(join(dir, 'unknown.ts')), 'tsc')).not.toThrow();
  });

  it('rejects zero roots', () => {
    expect(() => new WorkspaceIndex({ roots: [] })).toThrow();
  });
});
