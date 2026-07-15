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

  constructor(delegate?: ProjectResolverDelegate) {
    this.delegate = delegate ?? defaultDelegate;
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

  resolveTypeScriptModule(fromDir: string): { path: string; version: string } | undefined {
    const workspaceTypeScript = this.traverseUpForTypeScript(fromDir);
    if (workspaceTypeScript) return workspaceTypeScript;

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
        return {
          path: path.dirname(packageJsonPath),
          version: pkg.version,
        };
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

    const typescriptLibDir = path.join(extPath, 'node_modules', 'typescript');
    const packageJsonPath = path.join(typescriptLibDir, 'package.json');

    const pkg = this.delegate.readPackageJson(packageJsonPath);
    if (!pkg || typeof pkg.version !== 'string') return undefined;

    return {
      path: typescriptLibDir,
      version: pkg.version,
    };
  }
}
