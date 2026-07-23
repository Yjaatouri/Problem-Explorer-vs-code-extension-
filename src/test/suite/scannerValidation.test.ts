import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { TscConfig } from '../../core/types';
import { TscDiagnosticProvider } from '../../providers/TscDiagnosticProvider';
import { ProjectResolver, ProjectResolverDelegate } from '../../typescript/ProjectResolver';
import { TscRunner, TscRunnerDelegate, TscProcess } from '../../typescript/TscRunner';
import { TscOutputParser } from '../../typescript/TscOutputParser';

const TS_VERSION = '5.5.0';

interface ProjectLayout {
  name: string;
  tsconfigPaths: string[];
  errors: string[];
  expectedFileCount: number;
  expectedErrorCount: number;
  expectedWarningCount: number;
}

class FakeTscDelegate implements TscRunnerDelegate {
  private errors: string[];

  constructor(errors: string[]) {
    this.errors = errors;
  }

  spawn(_command: string, _args: string[]): TscProcess {
    const output = this.errors.join('\n');
    const dataListeners: Array<(chunk: string) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];

    setImmediate(() => {
      for (const listener of dataListeners) listener(output);
      setImmediate(() => {
        for (const listener of closeListeners) listener(0);
      });
    });

    return {
      stdout: { on: (_event: 'data', listener: (chunk: string) => void) => { dataListeners.push(listener); } },
      stderr: { on: (_event: 'data', _listener: (chunk: string) => void) => {} },
      on: (_event: 'close' | 'error', listener: ((code: number | null) => void) | ((err: Error) => void)) => {
        if (_event === 'close') closeListeners.push(listener as (code: number | null) => void);
      },
      kill: () => {},
    };
  }
}

function makeResolver(tsconfigPaths: string[]): ProjectResolver {
  const delegate: ProjectResolverDelegate = {
    workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'root', index: 0 }],
    findFiles: async () => tsconfigPaths.map((p) => Uri.file(p)),
    readFile: async () => '',
    moduleExists: () => true,
    readPackageJson: (p) => {
      if (p.includes('typescript')) return { version: TS_VERSION };
      return undefined;
    },
    getExtensionPath: () => '/ext/typescript',
  };
  const resolver = new ProjectResolver(delegate);
  resolver.useWorkspaceVersion = true;
  return resolver;
}

suite('ScannerValidation', () => {
  const projects: ProjectLayout[] = [
    {
      name: 'React (CRA)',
      tsconfigPaths: ['/workspace/tsconfig.json'],
      errors: [
        'src/App.tsx(23,12): error TS2322: Type \'number\' is not assignable to type \'string\'.',
        'src/components/Button.tsx(8,3): error TS2786: \'React.FC\' cannot be used as a JSX component.',
        'src/hooks/useAuth.ts(15,7): warning TS6133: \'token\' is declared but never used.',
      ],
      expectedFileCount: 3,
      expectedErrorCount: 2,
      expectedWarningCount: 1,
    },
    {
      name: 'Next.js',
      tsconfigPaths: ['/workspace/tsconfig.json'],
      errors: [
        'src/app/page.tsx(10,18): error TS2322: Type \'null\' is not assignable to type \'string\'.',
        'src/app/layout.tsx(5,1): error TS2786: Page prop type mismatch.',
        'src/lib/api.ts(42,4): warning TS6385: \'data\' is deprecated.',
        'middleware.ts(1,1): error TS2304: Cannot find name \'NextRequest\'.',
      ],
      expectedFileCount: 4,
      expectedErrorCount: 3,
      expectedWarningCount: 1,
    },
    {
      name: 'Vite',
      tsconfigPaths: ['/workspace/tsconfig.json', '/workspace/tsconfig.node.json'],
      errors: [
        'src/main.ts(1,1): error TS2304: Cannot find module \'vite/client\'.',
        'src/App.vue(45,5): error TS2322: Type \'Ref<string>\' is not assignable.',
      ],
      expectedFileCount: 2,
      expectedErrorCount: 2,
      expectedWarningCount: 0,
    },
    {
      name: 'Node',
      tsconfigPaths: ['/workspace/tsconfig.json'],
      errors: [
        'src/server.ts(25,18): error TS2580: Cannot find name \'require\'.',
        'src/routes/index.ts(10,5): warning TS6133: \'req\' is declared but never used.',
        'src/models/user.ts(35,8): error TS2345: Argument of type \'string | undefined\' is not assignable.',
      ],
      expectedFileCount: 3,
      expectedErrorCount: 2,
      expectedWarningCount: 1,
    },
    {
      name: 'NestJS',
      tsconfigPaths: ['/workspace/tsconfig.json', '/workspace/tsconfig.build.json'],
      errors: [
        'src/app.module.ts(12,5): error TS1240: Unable to resolve signature of class decorator.',
        'src/users/users.service.ts(33,12): error TS2322: Type \'unknown\' is not assignable.',
        'src/auth/auth.guard.ts(8,3): warning TS6133: \'context\' is declared but never used.',
      ],
      expectedFileCount: 3,
      expectedErrorCount: 2,
      expectedWarningCount: 1,
    },
    {
      name: 'Monorepo',
      tsconfigPaths: [
        '/workspace/tsconfig.json',
        '/workspace/packages/core/tsconfig.json',
        '/workspace/packages/web/tsconfig.json',
        '/workspace/packages/api/tsconfig.json',
      ],
      errors: [
        'packages/core/src/index.ts(5,12): error TS2322: Type mismatch in shared type.',
        'packages/web/src/app.tsx(22,5): error TS2304: Cannot find name \'Component\'.',
        'packages/api/src/handler.ts(8,3): warning TS6133: \'event\' is declared but never used.',
      ],
      expectedFileCount: 3,
      expectedErrorCount: 2,
      expectedWarningCount: 1,
    },
    {
      name: 'Large project',
      tsconfigPaths: Array.from({ length: 50 }, (_, i) =>
        `/workspace/packages/pkg${i}/tsconfig.json`,
      ),
      errors: (() => {
        const lines: string[] = [];
        for (let i = 0; i < 100; i++) {
          const sev = i % 5 === 0 ? 'warning' : 'error';
          lines.push(`src/file${i}.ts(${i + 1},1): ${sev} TS99${i}: Diagnostic ${i}.`);
        }
        return lines;
      })(),
      expectedFileCount: 100,
      expectedErrorCount: 80,
      expectedWarningCount: 20,
    },
  ];

  for (const project of projects) {
    test(project.name, async () => {
      const store = new ProblemStore();
      const resolver = makeResolver(project.tsconfigPaths);
      const tscDelegate = new FakeTscDelegate(project.errors);
      const runner = new TscRunner(tscDelegate);
      const parser = new TscOutputParser();
      const provider = new TscDiagnosticProvider(store, { projectResolver: resolver, tscRunner: runner, outputParser: parser });
      const tscCfg: TscConfig = { enabled: true, autoScan: true, scanOnStartup: false, timeout: 120000, useWorkspaceVersion: true, maxConcurrentScans: 1 };
      provider.updateConfig(tscCfg);

      const changed = await provider.runScan();
      const totals = store.computeTotals();

      assert.strictEqual(
        changed.length, project.expectedFileCount,
        `${project.name}: expected ${project.expectedFileCount} changed files, got ${changed.length}`,
      );
      assert.strictEqual(
        totals.errorCount, project.expectedErrorCount,
        `${project.name}: expected ${project.expectedErrorCount} errors, got ${totals.errorCount}`,
      );
      assert.strictEqual(
        totals.warningCount, project.expectedWarningCount,
        `${project.name}: expected ${project.expectedWarningCount} warnings, got ${totals.warningCount}`,
      );

      assert.ok(provider.lastScanDurationMs >= 0, `${project.name}: duration should be >= 0`);
      assert.strictEqual(provider.lastScanErrors.length, 0, `${project.name}: should have no scan errors`);

      store.dispose();
      provider.dispose();
    });
  }

  test('Large project resolves all tsconfig files', async () => {
    const tsconfigPaths = Array.from({ length: 50 }, (_, i) =>
      `/workspace/packages/pkg${i}/tsconfig.json`,
    );
    const resolver = makeResolver(tsconfigPaths);
    const projects = await resolver.resolveAll();
    assert.strictEqual(projects.length, 50);
  });

  test('Monorepo preserves package-level error counts', async () => {
    const store = new ProblemStore();
    const tsconfigPaths = [
      '/workspace/tsconfig.json',
      '/workspace/packages/core/tsconfig.json',
      '/workspace/packages/web/tsconfig.json',
    ];
    const errors = [
      'packages/core/src/db.ts(1,1): error TS2322: DB type error.',
      'packages/core/src/db.ts(2,1): error TS2322: Another DB error.',
      'packages/web/src/ui.tsx(5,1): error TS2345: UI type error.',
      'packages/web/src/ui.tsx(6,1): warning TS6133: unused var.',
    ];
    const resolver = makeResolver(tsconfigPaths);
    const tscDelegate = new FakeTscDelegate(errors);
    const runner = new TscRunner(tscDelegate);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, { projectResolver: resolver, tscRunner: runner, outputParser: parser });
    const tscCfg: TscConfig = { enabled: true, autoScan: true, scanOnStartup: false, timeout: 120000, useWorkspaceVersion: true, maxConcurrentScans: 1 };
    provider.updateConfig(tscCfg);

    await provider.runScan();

    const coreUri = Uri.file('/workspace/packages/core/src/db.ts');
    const uiUri = Uri.file('/workspace/packages/web/src/ui.tsx');
    const coreState = store.get(coreUri);
    const uiState = store.get(uiUri);

    assert.ok(coreState);
    assert.strictEqual(coreState!.errorCount, 2);
    assert.strictEqual(coreState!.warningCount, 0);

    assert.ok(uiState);
    assert.strictEqual(uiState!.errorCount, 1);
    assert.strictEqual(uiState!.warningCount, 1);

    store.dispose();
    provider.dispose();
  });
});
