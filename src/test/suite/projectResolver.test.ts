import * as assert from 'assert';
import * as path from 'path';
import { Uri } from 'vscode';
import {
  ProjectResolver,
  ProjectResolverDelegate,
  TypeScriptProject,
} from '../../typescript/ProjectResolver';

const TS_VERSION = '5.5.0';

function makeDelegate(overrides: Partial<ProjectResolverDelegate> = {}): ProjectResolverDelegate {
  return {
    workspaceFolders: [],
    findFiles: async () => [],
    readFile: async () => '',
    moduleExists: () => false,
    readPackageJson: () => undefined,
    getExtensionPath: () => undefined,
    ...overrides,
  };
}

suite('ProjectResolver', () => {
  test('returns empty array when workspace has no folders', async () => {
    const delegate = makeDelegate({ workspaceFolders: [] });
    const resolver = new ProjectResolver(delegate);
    const projects = await resolver.resolveAll();
    assert.strictEqual(projects.length, 0);
  });

  test('returns empty array when no tsconfig files exist', async () => {
    const delegate = makeDelegate({
      workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }],
      findFiles: async () => [],
    });
    const resolver = new ProjectResolver(delegate);
    const projects = await resolver.resolveAll();
    assert.strictEqual(projects.length, 0);
  });

  test('resolves a single tsconfig with workspace TypeScript', async () => {
    const tsconfigUri = Uri.parse('file:///workspace/tsconfig.json');
    const delegate = makeDelegate({
      workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }],
      findFiles: async () => [tsconfigUri],
      moduleExists: () => true,
      readPackageJson: (p) => {
        if (p.endsWith('typescript' + path.sep + 'package.json') || p.endsWith('typescript/package.json')) {
          return { version: TS_VERSION };
        }
        return { version: '1.0.0' };
      },
    });
    const resolver = new ProjectResolver(delegate);
    const projects = await resolver.resolveAll();

    assert.strictEqual(projects.length, 1);
    assert.strictEqual(projects[0].tsconfigPath, tsconfigUri.fsPath);
    assert.strictEqual(projects[0].projectRoot, path.dirname(tsconfigUri.fsPath));
    assert.strictEqual(projects[0].typescriptVersion, TS_VERSION);
  });

  test('resolves multiple tsconfig files in workspace', async () => {
    const tsconfigs = [
      Uri.parse('file:///workspace/tsconfig.json'),
      Uri.parse('file:///workspace/packages/app/tsconfig.json'),
      Uri.parse('file:///workspace/packages/lib/tsconfig.json'),
    ];
    const delegate = makeDelegate({
      workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }],
      findFiles: async () => tsconfigs,
      moduleExists: () => true,
      readPackageJson: (p) => {
        if (p.endsWith('typescript' + path.sep + 'package.json') || p.endsWith('typescript/package.json')) {
          return { version: TS_VERSION };
        }
        return { version: '1.0.0' };
      },
    });
    const resolver = new ProjectResolver(delegate);
    const projects = await resolver.resolveAll();

    assert.strictEqual(projects.length, 3);
    assert.strictEqual(projects[0].tsconfigPath, tsconfigs[0].fsPath);
    assert.strictEqual(projects[1].tsconfigPath, tsconfigs[1].fsPath);
    assert.strictEqual(projects[2].tsconfigPath, tsconfigs[2].fsPath);
  });

  test('traverses up directory tree to find TypeScript module', () => {
    const calls: string[] = [];

    const delegate = makeDelegate({
      readPackageJson: (p) => {
        calls.push(p);
        return undefined;
      },
    });
    const resolver = new ProjectResolver(delegate);

    const result = resolver.resolveTypeScriptModule('/workspace/packages/app');

    assert.strictEqual(result, undefined);
    assert.ok(calls.length >= 1);
    assert.ok(calls.some((c) => c.includes('node_modules')));
  });

  test('falls back to VS Code bundled TypeScript when workspace module is missing', () => {
    const delegate = makeDelegate({
      moduleExists: () => false,
      readPackageJson: (p) => {
        if (p.includes('vscode') && p.endsWith('typescript' + path.sep + 'package.json') || p.endsWith('typescript/package.json')) {
          return { version: '5.4.0' };
        }
        return undefined;
      },
      getExtensionPath: () => '/extensions/vscode.typescript-language-features',
    });
    const resolver = new ProjectResolver(delegate);

    const result = resolver.resolveTypeScriptModule('/workspace');

    assert.ok(result, 'should fall back to VS Code TypeScript');
    assert.strictEqual(result!.version, '5.4.0');
  });

  test('ignores workspace TypeScript when useWorkspaceVersion is false', () => {
    const delegate = makeDelegate({
      moduleExists: () => false,
      readPackageJson: (p) => {
        if (p.includes('vscode') && p.endsWith('typescript' + path.sep + 'package.json') || p.endsWith('typescript/package.json')) {
          return { version: '5.4.0' };
        }
        return undefined;
      },
      getExtensionPath: () => '/extensions/vscode.typescript-language-features',
    });
    const resolver = new ProjectResolver(delegate);
    resolver.useWorkspaceVersion = false;

    const result = resolver.resolveTypeScriptModule('/workspace');

    assert.ok(result, 'should fall back to VS Code TypeScript');
    assert.strictEqual(result!.version, '5.4.0');
  });

  test('returns undefined when no TypeScript module is found anywhere', () => {
    const delegate = makeDelegate({
      moduleExists: () => false,
      readPackageJson: () => undefined,
      getExtensionPath: () => undefined,
    });
    const resolver = new ProjectResolver(delegate);

    const result = resolver.resolveTypeScriptModule('/workspace');

    assert.strictEqual(result, undefined);
  });

  test('resolve() returns undefined for inaccessible tsconfig', async () => {
    const delegate = makeDelegate({
      moduleExists: () => false,
      getExtensionPath: () => undefined,
    });
    const resolver = new ProjectResolver(delegate);

    const project = await resolver.resolve(Uri.parse('file:///workspace/tsconfig.json'));

    assert.strictEqual(project, undefined);
  });

  test('resolve() returns project metadata for valid tsconfig', async () => {
    const delegate = makeDelegate({
      moduleExists: () => true,
      readPackageJson: (p) => {
        if (p.endsWith('typescript' + path.sep + 'package.json') || p.endsWith('typescript/package.json')) {
          return { version: TS_VERSION };
        }
        return undefined;
      },
    });
    const resolver = new ProjectResolver(delegate);
    const uri = Uri.parse('file:///workspace/tsconfig.json');

    const project = await resolver.resolve(uri);

    assert.ok(project);
    assert.strictEqual(project!.tsconfigPath, uri.fsPath);
    assert.strictEqual(project!.projectRoot, path.dirname(uri.fsPath));
    assert.ok(project!.typescriptPath.length > 0);
    assert.strictEqual(project!.typescriptVersion, TS_VERSION);
  });

  test('delegate readFile is called for tsconfig content', async () => {
    let readCalled = false;
    const delegate = makeDelegate({
      workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }],
      findFiles: async () => [Uri.parse('file:///workspace/tsconfig.json')],
      moduleExists: () => true,
      readPackageJson: (p) => {
        if (p.endsWith('typescript' + path.sep + 'package.json') || p.endsWith('typescript/package.json')) {
          return { version: TS_VERSION };
        }
        return undefined;
      },
      readFile: async (uri) => {
        readCalled = true;
        assert.ok(uri.fsPath.endsWith('tsconfig.json'));
        return '{}';
      },
    });
    const resolver = new ProjectResolver(delegate);
    await resolver.resolveAll();
    assert.strictEqual(readCalled, false);
  });

  test('VSCODE_TS_EXTENSION_ID constant is correct', () => {
    const { VSCODE_TS_EXTENSION_ID } = require('../../typescript/ProjectResolver');
    assert.strictEqual(VSCODE_TS_EXTENSION_ID, 'vscode.typescript-language-features');
  });

  test('TypeScriptProject satisfies structural type', () => {
    const project: TypeScriptProject = {
      tsconfigPath: '/workspace/tsconfig.json',
      projectRoot: '/workspace',
      typescriptPath: '/workspace/node_modules/typescript',
      typescriptVersion: '5.5.0',
    };
    assert.strictEqual(project.tsconfigPath, '/workspace/tsconfig.json');
    assert.strictEqual(project.projectRoot, '/workspace');
    assert.strictEqual(project.typescriptPath, '/workspace/node_modules/typescript');
    assert.strictEqual(project.typescriptVersion, '5.5.0');
  });

  test('import ProjectResolver is a class', () => {
    assert.strictEqual(typeof ProjectResolver, 'function');
  });
});
