import { Uri, workspace, extensions, WorkspaceFolder } from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface EslintProjectResolverDelegate {
  readonly workspaceFolders: readonly WorkspaceFolder[];
  findFiles(pattern: string, exclude?: string): Thenable<Uri[]>;
  readFile(uri: Uri): Thenable<string>;
  moduleExists(modulePath: string): boolean;
  readPackageJson(packageJsonPath: string): { version?: string } | undefined;
  getExtensionPath(extensionId: string): string | undefined;
}

export interface ResolvedEslintExecutable {
  readonly path: string;
  readonly version: string;
}

export interface ResolvedEslintProject {
  readonly folder: WorkspaceFolder;
  readonly configPath?: string;
}

const defaultDelegate: EslintProjectResolverDelegate = {
  get workspaceFolders() {
    return workspace.workspaceFolders ?? [];
  },
  findFiles: (pattern, exclude) => workspace.findFiles(pattern, exclude),
  readFile: async (uri) => {
    const bytes = await workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  },
  moduleExists: (modulePath) => {
    try {
      fs.accessSync(modulePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  readPackageJson: (packageJsonPath) => {
    try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      return JSON.parse(content) as { version?: string };
    } catch {
      return undefined;
    }
  },
  getExtensionPath: (extensionId) => {
    const ext = extensions.getExtension(extensionId);
    if (!ext) return undefined;
    return ext.extensionUri.fsPath;
  },
};

const _CACHE_MISS = Symbol('CACHE_MISS');

export class EslintProjectResolver {
  private readonly delegate: EslintProjectResolverDelegate;
  private _cachedExecutable: ResolvedEslintExecutable | typeof _CACHE_MISS | undefined;
  private _cachedExecutableFromDir: string | undefined;
  private _cachedProjects: ResolvedEslintProject[] | undefined;
  private _cachedProjectsAt = 0;
  private readonly _cacheTtlMs: number;

  constructor(delegate?: EslintProjectResolverDelegate, cacheTtlMs = 60_000) {
    this.delegate = delegate ?? defaultDelegate;
    this._cacheTtlMs = cacheTtlMs;
  }

  clearCache(): void {
    this._cachedExecutable = undefined;
    this._cachedExecutableFromDir = undefined;
    this._cachedProjects = undefined;
    this._cachedProjectsAt = 0;
  }

  async resolveEslintExecutable(
    fromDir: string,
    explicitPath?: string
  ): Promise<ResolvedEslintExecutable | undefined> {
    console.log(`[LOG:ESLINT-resolver] resolveEslintExecutable fromDir=${fromDir} explicitPath=${explicitPath}`);
    if (explicitPath) {
      try {
        const stats = fs.statSync(explicitPath);
        if (stats.isFile() || (stats.isDirectory() && fs.existsSync(path.join(explicitPath, 'eslint')))) {
          const exePath = stats.isFile() ? explicitPath : path.join(explicitPath, 'eslint');
          const version = await this.getEslintVersion(exePath);
          if (version) {
            console.log(`[LOG:ESLINT-resolver] explicitPath resolved: ${exePath} v${version}`);
            return { path: exePath, version };
          }
        }
      } catch {
      }
      console.log('[LOG:ESLINT-resolver] explicitPath check failed');
    }

    if (this._cachedExecutable && this._cachedExecutableFromDir === fromDir) {
      if (this._cachedExecutable !== _CACHE_MISS) {
        console.log('[LOG:ESLINT-resolver] cache HIT for executable');
        return this._cachedExecutable;
      }
      console.log('[LOG:ESLINT-resolver] cache MISS for executable');
      return undefined;
    }

    const result = await this.findEslintExecutable(fromDir);

    this._cachedExecutable = result ?? _CACHE_MISS;
    this._cachedExecutableFromDir = fromDir;
    if (result) {
      console.log(`[LOG:ESLINT-resolver] found executable: ${result.path} v${result.version}`);
    } else {
      console.log('[LOG:ESLINT-resolver] NO executable found');
    }
    return result;
  }

  private async findEslintExecutable(
    startDir: string
  ): Promise<ResolvedEslintExecutable | undefined> {
    console.log(`[LOG:ESLINT-resolver] findEslintExecutable startDir=${startDir}`);
    let current = path.resolve(startDir);

    for (let i = 0; i < 20; i++) {
      const candidateBin = path.join(current, 'node_modules', '.bin', 'eslint');
      if (this.delegate.moduleExists(candidateBin)) {
        console.log(`[LOG:ESLINT-resolver] found candidateBin: ${candidateBin}`);
        const version = await this.getEslintVersion(candidateBin);
        if (version) {
          return { path: candidateBin, version };
        }
      }
      const candidateDir = path.join(current, 'node_modules', 'eslint');
      if (this.delegate.moduleExists(candidateDir)) {
        const binPath = path.join(candidateDir, 'bin', 'eslint.js');
        if (this.delegate.moduleExists(binPath)) {
          console.log(`[LOG:ESLINT-resolver] found candidateDir: ${binPath}`);
          const version = await this.getEslintVersion(binPath);
          if (version) {
            return { path: binPath, version };
          }
        }
      }

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    if (this.delegate.workspaceFolders.length > 0) {
      const rootDir = this.delegate.workspaceFolders[0].uri.fsPath;
      console.log(`[LOG:ESLINT-resolver] checking rootDir: ${rootDir}`);
      const rootCandidateBin = path.join(rootDir, 'node_modules', '.bin', 'eslint');
      if (this.delegate.moduleExists(rootCandidateBin)) {
        const version = await this.getEslintVersion(rootCandidateBin);
        if (version) {
          return { path: rootCandidateBin, version };
        }
      }
      const rootCandidateDir = path.join(rootDir, 'node_modules', 'eslint');
      if (this.delegate.moduleExists(rootCandidateDir)) {
        const binPath = path.join(rootCandidateDir, 'bin', 'eslint.js');
        if (this.delegate.moduleExists(binPath)) {
          const version = await this.getEslintVersion(binPath);
          if (version) {
            return { path: binPath, version };
          }
        }
      }
    }

    console.log('[LOG:ESLINT-resolver] checking PATH');
    const pathEslint = this.findInPath('eslint');
    if (pathEslint) {
      console.log(`[LOG:ESLINT-resolver] found in PATH: ${pathEslint}`);
      const version = await this.getEslintVersion(pathEslint);
      if (version) {
        return { path: pathEslint, version };
      }
    }

    console.log('[LOG:ESLINT-resolver] NO executable found anywhere');
    return undefined;
  }

  private findInPath(command: string): string | undefined {
    const paths = (process.env.PATH ?? '').split(path.delimiter);
    for (const p of paths) {
      const candidate = path.join(p, command);
      if (this.delegate.moduleExists(candidate)) {
        return candidate;
      }
      const candidateExt = candidate + (process.platform === 'win32' ? '.cmd' : '');
      if (this.delegate.moduleExists(candidateExt)) {
        return candidateExt;
      }
    }
    return undefined;
  }

  private async getEslintVersion(executablePath: string): Promise<string | undefined> {
    console.log(`[LOG:ESLINT-resolver] getEslintVersion: ${executablePath}`);
    return new Promise((resolve) => {
      try {
        const { spawn } = require('node:child_process');
        const child = spawn(executablePath, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stdout = '';
        const timeout = setTimeout(() => {
          child.kill();
          console.log('[LOG:ESLINT-resolver] getEslintVersion TIMEOUT');
          resolve(undefined);
        }, 3000);

        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

        child.on('close', (code: number | null) => {
          clearTimeout(timeout);
          if (code === 0 && stdout.trim().length > 0) {
            console.log(`[LOG:ESLINT-resolver] getEslintVersion SUCCESS: ${stdout.trim()}`);
            resolve(stdout.trim());
          } else {
            console.log(`[LOG:ESLINT-resolver] getEslintVersion FAILED code=${code} stdout='${stdout}'`);
            resolve(undefined);
          }
        });

        child.on('error', (err: Error) => {
          clearTimeout(timeout);
          console.log(`[LOG:ESLINT-resolver] getEslintVersion ERROR: ${err.message}`);
          resolve(undefined);
        });
      } catch (err) {
        console.log('[LOG:ESLINT-resolver] getEslintVersion EXCEPTION');
        resolve(undefined);
      }
    });
  }

  async resolveProjects(): Promise<ResolvedEslintProject[]> {
    console.log('[LOG:ESLINT-resolver] resolveProjects CALLED');
    if (this._cachedProjects && Date.now() - this._cachedProjectsAt < this._cacheTtlMs) {
      console.log('[LOG:ESLINT-resolver] cache HIT');
      return this._cachedProjects;
    }

    const projects: ResolvedEslintProject[] = [];

    if (this.delegate.workspaceFolders.length === 0) {
      console.log('[LOG:ESLINT-resolver] no workspaceFolders');
      this._cachedProjects = projects;
      this._cachedProjectsAt = Date.now();
      return projects;
    }

    const configPatterns = [
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.yaml',
      '.eslintrc.yml',
      '.eslintrc.json',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ];

    for (const folder of this.delegate.workspaceFolders) {
      let configPath: string | undefined;

      for (const configFile of configPatterns) {
        try {
          await this.delegate.readFile(Uri.joinPath(folder.uri, configFile));
          configPath = configFile;
          console.log(`[LOG:ESLINT-resolver] found config: ${configFile} in ${folder.name}`);
          break;
        } catch {
        }
      }

      if (!configPath) {
        try {
          const pkgContent = await this.delegate.readFile(Uri.joinPath(folder.uri, 'package.json'));
          const pkg = JSON.parse(pkgContent);
          if (pkg.eslintConfig) {
            configPath = 'package.json';
            console.log(`[LOG:ESLINT-resolver] found eslintConfig in package.json in ${folder.name}`);
          }
        } catch {
        }
      }

      if (configPath) {
        projects.push({ folder, configPath });
        console.log(`[LOG:ESLINT-resolver] added project: ${folder.name} with config=${configPath}`);
      } else {
        console.log(`[LOG:ESLINT-resolver] NO config found in ${folder.name}, skipping`);
      }
    }

    this._cachedProjects = projects;
    this._cachedProjectsAt = Date.now();
    console.log(`[LOG:ESLINT-resolver] returning ${projects.length} projects`);
    return projects;
  }
}