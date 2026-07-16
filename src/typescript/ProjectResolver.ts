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
    console.log(`[TSC] resolveTypeScriptModule fromDir=${fromDir}`);

    // 1. Try workspace TypeScript (traverse up for node_modules/typescript)
    if (this._useWorkspaceVersion) {
      const workspaceTypeScript = this.traverseUpForTypeScript(fromDir);
      if (workspaceTypeScript) {
        console.log(`[TSC] Using workspace TypeScript`);
        console.log(`[TSC] Version: ${workspaceTypeScript.version}`);
        console.log(`[TSC] Compiler: ${path.join(workspaceTypeScript.path, 'lib', 'tsc.js')}`);
        return workspaceTypeScript;
      }
      console.log(`[TSC] Workspace TypeScript: not found`);
    } else {
      console.log(`[TSC] Workspace TypeScript: skipped (useWorkspaceVersion=false)`);
    }

    // 2. Try VS Code bundled TypeScript
    console.log(`[TSC] Checking VS Code bundled TypeScript...`);
    const vsCodeTypeScript = this.getVSCodeTypeScript();
    if (vsCodeTypeScript) {
      console.log(`[TSC] Using VS Code TypeScript`);
      console.log(`[TSC] Version: ${vsCodeTypeScript.version}`);
      console.log(`[TSC] Compiler: ${path.join(vsCodeTypeScript.path, 'lib', 'tsc.js')}`);
      return vsCodeTypeScript;
    }

    // 3. No runnable compiler found
    console.log(`[TSC] No runnable TypeScript compiler found`);
    console.log(`[TSC]   Action: Install TypeScript in your workspace (npm install typescript --save-dev)`);
    return undefined;
  }

  private traverseUpForTypeScript(startDir: string): { path: string; version: string } | undefined {
    let current = path.resolve(startDir);
    console.log(`[TSC] traverseUpForTypeScript start=${current}`);

    for (let i = 0; i < 20; i++) {
      const candidatePkgJson = path.join(current, 'node_modules', 'typescript', 'package.json');
      console.log(`[TSC] traverseUp: checking ${candidatePkgJson}`);
      const pkg = this.delegate.readPackageJson(candidatePkgJson);
      if (pkg && typeof pkg.version === 'string') {
        const tsDir = path.dirname(candidatePkgJson);
        const hasTsc = this.tscExists(tsDir);
        console.log(`[TSC] traverseUp: found version=${pkg.version} tsc.js=${hasTsc} at ${tsDir}`);
        if (hasTsc) {
          return {
            path: tsDir,
            version: pkg.version,
          };
        }
        console.log(`[TSC] traverseUp: skipping — no lib/tsc.js at ${path.join(tsDir, 'lib', 'tsc.js')}`);
      }

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    console.log(`[TSC] traverseUpForTypeScript: exhausted search (no valid TypeScript found)`);
    return undefined;
  }

  private getVSCodeTypeScript(): { path: string; version: string } | undefined {
    const extPath = this.delegate.getExtensionPath(VSCODE_TS_EXTENSION_ID);
    if (!extPath) {
      console.log(`[TSC] VS Code extension '${VSCODE_TS_EXTENSION_ID}' not found`);
      return undefined;
    }
    console.log(`[TSC] VS Code extension path: ${extPath}`);

    // Try per-extension node_modules (legacy VS Code structure)
    const perExtTsc = path.join(extPath, 'node_modules', 'typescript');
    console.log(`[TSC] Checking per-extension path: ${perExtTsc}`);
    const perExtHasTsc = this.tscExists(perExtTsc);
    console.log(`[TSC] per-extension lib/tsc.js: ${perExtHasTsc}`);
    if (perExtHasTsc) {
      const perExtPkg = path.join(perExtTsc, 'package.json');
      const pkg = this.delegate.readPackageJson(perExtPkg);
      if (pkg && typeof pkg.version === 'string') {
        return { path: perExtTsc, version: pkg.version };
      }
    }

    // Try shared extensions node_modules (modern VS Code ≥1.96)
    const sharedExtTsc = path.resolve(extPath, '..', 'node_modules', 'typescript');
    console.log(`[TSC] Checking shared path: ${sharedExtTsc}`);
    const sharedHasTsc = this.tscExists(sharedExtTsc);
    console.log(`[TSC] shared lib/tsc.js: ${sharedHasTsc}`);
    if (sharedHasTsc) {
      const sharedExtPkg = path.join(sharedExtTsc, 'package.json');
      const pkg = this.delegate.readPackageJson(sharedExtPkg);
      if (pkg && typeof pkg.version === 'string') {
        return { path: sharedExtTsc, version: pkg.version };
      }
    }

    console.log(`[TSC] VS Code TypeScript: invalid (missing lib/tsc.js at both candidate paths)`);
    return undefined;
  }
}
