import { Uri, workspace, WorkspaceFolder } from 'vscode';
import * as path from 'path';

export interface OxlintProjectResolverDelegate {
  readonly workspaceFolders: readonly WorkspaceFolder[];
  findFiles(pattern: string, exclude?: string): Thenable<Uri[]>;
  stat(uri: Uri): Thenable<{ type: number; ctime: number; mtime: number; size: number }>;
  pathExists(p: string): boolean;
  getExtensionPath(extensionId: string): string | undefined;
}

export interface ResolvedOxlintExecutable {
  /** Absolute path to the oxlint CLI script (`<pkg>/bin/oxlint`) — run via the Node host. */
  readonly path: string;
  readonly version: string;
}

export interface ResolvedOxlintProject {
  readonly folder: WorkspaceFolder;
  readonly configPath?: string;
}

const EXTENSION_ID = 'yjaatouri.problem-explorer';

const defaultDelegate: OxlintProjectResolverDelegate = {
  get workspaceFolders() {
    return workspace.workspaceFolders ?? [];
  },
  findFiles: (pattern, exclude) => workspace.findFiles(pattern, exclude),
  stat: async (uri) => workspace.fs.stat(uri),
  pathExists: (p) => {
    try {
      return require('fs').existsSync(p);
    } catch {
      return false;
    }
  },
  getExtensionPath: (extensionId) => {
    const ext = require('vscode').extensions.getExtension(extensionId);
    if (!ext) return undefined;
    return ext.extensionUri.fsPath;
  },
};

const _CACHE_MISS = Symbol('CACHE_MISS');

export class OxlintProjectResolver {
  private readonly delegate: OxlintProjectResolverDelegate;
  private _cachedProjects: { folder: WorkspaceFolder; configPath?: string }[] | undefined;
  private _cachedAt = 0;
  private _cachedExecutable: { path: string; version: string } | typeof _CACHE_MISS | undefined;
  private _cachedExecutableFromDir: string | undefined;

  constructor(delegate?: OxlintProjectResolverDelegate) {
    this.delegate = delegate ?? defaultDelegate;
  }

  clearCache(): void {
    this._cachedProjects = undefined;
    this._cachedAt = 0;
    this._cachedExecutable = undefined;
    this._cachedExecutableFromDir = undefined;
  }

  /**
   * Resolve the oxlint CLI script, in order:
   * 1. Explicit path (script file or oxlint package directory).
   * 2. `<dir>/node_modules/oxlint/bin/oxlint` walking up from `fromDir`.
   * 3. `<workspaceRoot>/node_modules/oxlint/bin/oxlint`.
   * 4. Bundled copy at `<extension>/dist/vendor/oxlint/bin/oxlint`.
   *
   * A candidate is only accepted if `oxlint --version` runs successfully,
   * which also proves its native binding loads.
   */
  async resolveOxlintExecutable(
    fromDir: string,
    explicitPath?: string
  ): Promise<ResolvedOxlintExecutable | undefined> {
    if (explicitPath) {
      const candidate = this.candidateFromExplicit(explicitPath);
      if (candidate) {
        const version = await this.getOxlintVersion(candidate);
        if (version) {
          return { path: candidate, version };
        }
      }
    }

    if (this._cachedExecutable && this._cachedExecutableFromDir === fromDir) {
      if (this._cachedExecutable !== _CACHE_MISS) {
        return this._cachedExecutable;
      }
      return undefined;
    }

    const result = await this.findOxlintExecutable(fromDir);

    this._cachedExecutable = result ?? _CACHE_MISS;
    this._cachedExecutableFromDir = fromDir;
    return result;
  }

  private candidateFromExplicit(explicitPath: string): string | undefined {
    const fs = require('fs');
    try {
      const stats = fs.statSync(explicitPath);
      if (stats.isFile()) {
        return explicitPath;
      }
      // Directory: treat as oxlint package dir or its parent.
      const candidates = [
        path.join(explicitPath, 'bin', 'oxlint'),
        path.join(explicitPath, 'node_modules', 'oxlint', 'bin', 'oxlint'),
      ];
      for (const c of candidates) {
        if (this.delegate.pathExists(c)) {
          return c;
        }
      }
    } catch {
    }
    return undefined;
  }

  private async findOxlintExecutable(
    startDir: string
  ): Promise<ResolvedOxlintExecutable | undefined> {
    // 1) Walk up from startDir looking for a workspace-local install.
    let current = path.resolve(startDir);
    for (let i = 0; i < 20; i++) {
      const candidate = path.join(current, 'node_modules', 'oxlint', 'bin', 'oxlint');
      if (this.delegate.pathExists(candidate)) {
        const version = await this.getOxlintVersion(candidate);
        if (version) {
          return { path: candidate, version };
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    // 2) Workspace roots (covers fromDir outside the root folders).
    for (const folder of this.delegate.workspaceFolders) {
      const candidate = path.join(folder.uri.fsPath, 'node_modules', 'oxlint', 'bin', 'oxlint');
      if (this.delegate.pathExists(candidate)) {
        const version = await this.getOxlintVersion(candidate);
        if (version) {
          return { path: candidate, version };
        }
      }
    }

    // 3) Bundled copy shipped with the extension — always available.
    const extPath = this.delegate.getExtensionPath(EXTENSION_ID);
    if (extPath) {
      const bundled = path.join(extPath, 'dist', 'vendor', 'oxlint', 'bin', 'oxlint');
      if (this.delegate.pathExists(bundled)) {
        const version = await this.getOxlintVersion(bundled);
        if (version) {
          return { path: bundled, version };
        }
      }
    }

    return undefined;
  }

  /**
   * Run `oxlint --version` through the Node host. In the extension host,
   * process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE=1 makes it
   * behave as plain Node so the ESM CLI script runs.
   */
  private async getOxlintVersion(scriptPath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, [scriptPath, '--version'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stdout = '';
        const timeout = setTimeout(() => {
          try { child.kill(); } catch {}
          resolve(undefined);
        }, 5000);

        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

        child.on('close', (code: number | null) => {
          clearTimeout(timeout);
          if (code === 0 && stdout.trim().length > 0) {
            resolve(stdout.trim());
          } else {
            resolve(undefined);
          }
        });

        child.on('error', () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      } catch {
        resolve(undefined);
      }
    });
  }

  async resolveProjects(): Promise<{ folder: WorkspaceFolder; configPath?: string }[]> {
    if (this._cachedProjects && Date.now() - this._cachedAt < 60_000) {
      return this._cachedProjects;
    }

    const projects: { folder: WorkspaceFolder; configPath?: string }[] = [];

    if (this.delegate.workspaceFolders.length === 0) {
      return [];
    }

    const hasJsTsFiles = await this.hasJsTsFiles();
    if (!hasJsTsFiles) {
      this._cachedProjects = [];
      this._cachedAt = Date.now();
      return [];
    }

    for (const folder of this.delegate.workspaceFolders) {
      let configPath: string | undefined;

      const configFiles = [
        '.oxlintrc.json',
        '.oxlintrc.yaml',
        '.oxlintrc.yml',
        'oxlint.config.js',
        'oxlint.config.mjs',
        'oxlint.config.cjs',
        'oxlint.config.ts',
      ];

      for (const configFile of configFiles) {
        try {
          const configUri = Uri.joinPath(folder.uri, configFile);
          await this.delegate.stat(configUri);
          configPath = configFile;
          break;
        } catch {
        }
      }

      if (!configPath) {
        try {
          const pkgUri = Uri.joinPath(folder.uri, 'package.json');
          const pkgContent = await workspace.fs.readFile(pkgUri);
          const pkg = JSON.parse(new TextDecoder().decode(pkgContent));
          if (pkg.oxlintConfig) {
            configPath = 'package.json';
          }
        } catch {
        }
      }

      projects.push({ folder, configPath });
    }

    this._cachedProjects = projects;
    this._cachedAt = Date.now();
    return projects;
  }

  private async hasJsTsFiles(): Promise<boolean> {
    try {
      const files = await this.delegate.findFiles(
        '**/*.{js,jsx,mjs,cjs,ts,tsx}',
        '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/target/**'
      );
      return files.length > 0;
    } catch {
      return false;
    }
  }
}
