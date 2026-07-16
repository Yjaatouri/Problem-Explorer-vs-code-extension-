import { Uri, workspace, extensions, WorkspaceFolder } from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface TypeScriptProject {
  readonly tsconfigPath: string;
  readonly projectRoot: string;
  readonly typescriptPath: string;
  readonly typescriptVersion: string;
}

export interface ProjectResolverDelegate {
  readonly workspaceFolders: readonly WorkspaceFolder[];
  findFiles(pattern: string, exclude?: string): Thenable<Uri[]>;
  readFile(uri: Uri): Thenable<string>;
  moduleExists(modulePath: string): boolean;
  readPackageJson(packageJsonPath: string): Record<string, unknown> | undefined;
  getExtensionPath(extensionId: string): string | undefined;
}

export const VSCODE_TS_EXTENSION_ID = 'vscode.typescript-language-features';
export const NPX_SENTINEL = '__npx__';

const defaultDelegate: ProjectResolverDelegate = {
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
      return JSON.parse(content) as Record<string, unknown>;
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

export class ProjectResolver {
  private readonly delegate: ProjectResolverDelegate;
  private _useWorkspaceVersion = true;

  constructor(delegate?: ProjectResolverDelegate) {
    this.delegate = delegate ?? defaultDelegate;
  }

  set useWorkspaceVersion(value: boolean) {
    this._useWorkspaceVersion = value;
  }

  async resolveAll(): Promise<TypeScriptProject[]> {
    const projects: TypeScriptProject[] = [];

    if (this.delegate.workspaceFolders.length === 0) {
      return projects;
    }

    const tsconfigUris = await this.delegate.findFiles('**/tsconfig.json', '**/node_modules/**');

    for (const uri of tsconfigUris) {
      const project = await this.resolve(uri);
      if (project) {
        projects.push(project);
      }
    }

    return projects;
  }

  async resolve(tsconfigUri: Uri): Promise<TypeScriptProject | undefined> {
    const tsconfigPath = tsconfigUri.fsPath;
    const projectRoot = path.dirname(tsconfigPath);

    const resolved = this.resolveTypeScriptModule(projectRoot);
    if (!resolved) return undefined;

    return {
      tsconfigPath,
      projectRoot,
      typescriptPath: resolved.path,
      typescriptVersion: resolved.version,
    };
  }

  private tscExists(typescriptDir: string): boolean {
    return this.delegate.moduleExists(path.join(typescriptDir, 'lib', 'tsc.js'));
  }

  resolveTypeScriptModule(fromDir: string): { path: string; version: string } | undefined {
    if (this._useWorkspaceVersion) {
      const workspaceTypeScript = this.traverseUpForTypeScript(fromDir);
      if (workspaceTypeScript) return workspaceTypeScript;
      return { path: NPX_SENTINEL, version: 'npx' };
    }

    const vsCodeTypeScript = this.getVSCodeTypeScript();
    if (vsCodeTypeScript) return vsCodeTypeScript;

    return undefined;
  }

  private traverseUpForTypeScript(startDir: string): { path: string; version: string } | undefined {
    let current = path.resolve(startDir);

    for (let i = 0; i < 20; i++) {
      const packageJsonPath = path.join(current, 'node_modules', 'typescript', 'package.json');
      const pkg = this.delegate.readPackageJson(packageJsonPath);
      if (pkg && typeof pkg.version === 'string') {
        const tsDir = path.dirname(packageJsonPath);
        if (this.tscExists(tsDir)) {
          return {
            path: tsDir,
            version: pkg.version,
          };
        }
      }

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return undefined;
  }

  private getVSCodeTypeScript(): { path: string; version: string } | undefined {
    const extPath = this.delegate.getExtensionPath(VSCODE_TS_EXTENSION_ID);
    if (!extPath) return undefined;

    // Try per-extension node_modules (legacy VS Code structure)
    const perExtTsc = path.join(extPath, 'node_modules', 'typescript');
    if (this.tscExists(perExtTsc)) {
      const perExtPkg = path.join(perExtTsc, 'package.json');
      const pkg = this.delegate.readPackageJson(perExtPkg);
      if (pkg && typeof pkg.version === 'string') {
        return { path: perExtTsc, version: pkg.version };
      }
    }

    // Try shared extensions node_modules (modern VS Code ≥1.96)
    const sharedExtTsc = path.resolve(extPath, '..', 'node_modules', 'typescript');
    if (this.tscExists(sharedExtTsc)) {
      const sharedExtPkg = path.join(sharedExtTsc, 'package.json');
      const pkg = this.delegate.readPackageJson(sharedExtPkg);
      if (pkg && typeof pkg.version === 'string') {
        return { path: sharedExtTsc, version: pkg.version };
      }
    }

    return undefined;
  }
}
