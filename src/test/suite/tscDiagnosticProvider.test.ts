import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';
import { TscDiagnosticProvider, TscScanContext, TscScanError, ScanTiming } from '../../providers/TscDiagnosticProvider';
import { ProjectResolver, TypeScriptProject } from '../../typescript/ProjectResolver';
import { TscRunner, TscRunnerDelegate, TscProcess } from '../../typescript/TscRunner';
import { TscOutputParser } from '../../typescript/TscOutputParser';

const mockProjects: TypeScriptProject[] = [
  {
    tsconfigPath: '/workspace/tsconfig.json',
    projectRoot: '/workspace',
    typescriptPath: '/workspace/node_modules/typescript',
    typescriptVersion: '5.5.0',
  },
];

function makeErrorOutput(): string {
  return [
    'src/a.ts(5,10): error TS2322: Type is not assignable.',
    'src/b.ts(12,3): warning TS6133: Unused variable.',
    'src/c.ts(20,1): error TS2345: Wrong arguments.',
  ].join('\n');
}

function makeEmptyOutput(): string {
  return '';
}

class FakeTscRunnerDelegate implements TscRunnerDelegate {
  private output: string;
  private delayMs: number;

  constructor(output: string, delayMs = 0) {
    this.output = output;
    this.delayMs = delayMs;
  }

  spawn(_command: string, _args: string[]): TscProcess {
    const output = this.output;
    const delay = this.delayMs;
    const dataListeners: Array<(chunk: string) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];

    setImmediate(() => {
      for (const listener of dataListeners) {
        listener(output);
      }
      setTimeout(() => {
        for (const listener of closeListeners) {
          listener(0);
        }
      }, delay);
    });

    return {
      stdout: {
        on: (_event: 'data', listener: (chunk: string) => void) => {
          dataListeners.push(listener);
        },
      },
      stderr: {
        on: (_event: 'data', _listener: (chunk: string) => void) => {},
      },
      on: (_event: 'close' | 'error', listener: ((code: number | null) => void) | ((err: Error) => void)) => {
        if (_event === 'close') { closeListeners.push(listener as (code: number | null) => void); }
      },
      kill: () => {},
    };
  }
}

class FakeProjectResolver {
  private projects: TypeScriptProject[];

  constructor(projects: TypeScriptProject[]) {
    this.projects = projects;
  }

  async resolveAll(): Promise<TypeScriptProject[]> {
    return this.projects;
  }
}

function makeProvider(
  overrides: {
    store?: ProblemStore;
    projects?: TypeScriptProject[];
    tscOutput?: string;
    tscDelayMs?: number;
  } = {},
): TscDiagnosticProvider {
  const store = overrides.store ?? new ProblemStore();
  const projects = overrides.projects ?? mockProjects;
  const tscOutput = overrides.tscOutput ?? makeErrorOutput();
  const tscDelayMs = overrides.tscDelayMs ?? 0;

  const projectResolver = new FakeProjectResolver(projects) as unknown as ProjectResolver;
  const fakeDelegate = new FakeTscRunnerDelegate(tscOutput, tscDelayMs);
  const tscRunner = new TscRunner(fakeDelegate);
  const parser = new TscOutputParser();

  return new TscDiagnosticProvider(store, { projectResolver, tscRunner, outputParser: parser });
}

suite('TscDiagnosticProvider', () => {
  test('satisfies DiagnosticProvider structural type', () => {
    const provider = makeProvider();
    assert.strictEqual(provider.name, 'tsc');
    assert.ok(typeof provider.onDidUpdate === 'function');
    assert.ok(typeof provider.initialize === 'function');
    assert.ok(typeof provider.start === 'function');
    assert.ok(typeof provider.stop === 'function');
    assert.ok(typeof provider.refresh === 'function');
    assert.ok(typeof provider.dispose === 'function');
    provider.dispose();
  });

  test('constructor accepts dependencies', () => {
    const store = new ProblemStore();
    const provider = new TscDiagnosticProvider(store);
    assert.strictEqual(provider.store, store);
    assert.strictEqual(provider.name, 'tsc');
    provider.dispose();
  });

  test('initialize runs scan and writes errors to store', async () => {
    const store = new ProblemStore();
    const provider = makeProvider({ store });

    await provider.initialize();

    const aState = store.get(Uri.file('/workspace/src/a.ts'));
    const bState = store.get(Uri.file('/workspace/src/b.ts'));
    const cState = store.get(Uri.file('/workspace/src/c.ts'));

    assert.ok(aState);
    assert.strictEqual(aState!.severity, ProblemSeverity.Error);
    assert.strictEqual(aState!.errorCount, 1);

    assert.ok(bState);
    assert.strictEqual(bState!.severity, ProblemSeverity.Warning);
    assert.strictEqual(bState!.warningCount, 1);
    assert.strictEqual(bState!.errorCount, 0);

    assert.ok(cState);
    assert.strictEqual(cState!.severity, ProblemSeverity.Error);
    assert.strictEqual(cState!.errorCount, 1);

    provider.dispose();
  });

  test('refresh re-runs scan and updates store', async () => {
    const store = new ProblemStore();
    const provider = makeProvider({ store });

    await provider.initialize();
    let state = store.get(Uri.file('/workspace/src/a.ts'));
    assert.ok(state);

    store.delete(Uri.file('/workspace/src/a.ts'));
    assert.strictEqual(store.get(Uri.file('/workspace/src/a.ts')), undefined);

    await provider.refresh();

    state = store.get(Uri.file('/workspace/src/a.ts'));
    assert.ok(state);
    assert.strictEqual(state!.severity, ProblemSeverity.Error);

    provider.dispose();
  });

  test('runScan returns URIs of changed files', async () => {
    const provider = makeProvider();
    const changed = await provider.runScan();
    assert.strictEqual(changed.length, 3);
    assert.ok(changed.some((u) => u.fsPath.endsWith('a.ts')));
    assert.ok(changed.some((u) => u.fsPath.endsWith('b.ts')));
    assert.ok(changed.some((u) => u.fsPath.endsWith('c.ts')));
    provider.dispose();
  });

  test('no projects returns empty results', async () => {
    const provider = makeProvider({ projects: [] });
    const changed = await provider.runScan();
    assert.strictEqual(changed.length, 0);
    provider.dispose();
  });

  test('empty compiler output writes nothing', async () => {
    const store = new ProblemStore();
    const provider = makeProvider({ store, tscOutput: makeEmptyOutput() });
    const changed = await provider.runScan();
    assert.strictEqual(changed.length, 0);
    assert.strictEqual(store.size, 0);
    provider.dispose();
  });

  test('stop cancels running scan', async () => {
    const provider = makeProvider({ tscDelayMs: 500 });
    const scanPromise = provider.runScan();
    provider.stop();
    const changed = await scanPromise;
    assert.strictEqual(changed.length, 0);
    provider.dispose();
  });

  test('dispose prevents further operations', async () => {
    const provider = makeProvider();
    provider.dispose();

    const result = await provider.runScan();
    assert.strictEqual(result.length, 0);
  });

  test('aggregateFileState with multiple errors and warnings', () => {
    const provider = makeProvider();
    const parser = new TscOutputParser();
    const diagnostics = parser.parse(makeErrorOutput());

    const grouped = new Map<string, typeof diagnostics>();
    for (const d of diagnostics) {
      const key = d.file;
      const arr = grouped.get(key) ?? [];
      arr.push(d);
      grouped.set(key, arr);
    }

    const aDiags = grouped.get('src/a.ts');
    assert.ok(aDiags);
    assert.strictEqual(aDiags!.length, 1);

    provider.dispose();
  });

  test('multiple projects are scanned', async () => {
    const store = new ProblemStore();
    const projects: TypeScriptProject[] = [
      {
        tsconfigPath: '/workspace/tsconfig.json',
        projectRoot: '/workspace',
        typescriptPath: '/workspace/node_modules/typescript',
        typescriptVersion: '5.5.0',
      },
      {
        tsconfigPath: '/workspace/packages/lib/tsconfig.json',
        projectRoot: '/workspace/packages/lib',
        typescriptPath: '/workspace/node_modules/typescript',
        typescriptVersion: '5.5.0',
      },
    ];
    const provider = makeProvider({ store, projects });
    const changed = await provider.runScan();
    assert.ok(changed.length >= 1);
    provider.dispose();
  });

  test('TscScanContext satisfies structural type', () => {
    const ctx: TscScanContext = {
      projects: mockProjects,
      diagnostics: new Map(),
    };
    assert.strictEqual(ctx.projects.length, 1);
    assert.strictEqual(ctx.diagnostics.size, 0);
  });

  test('scanning flag is true during scan', async () => {
    const provider = makeProvider({ tscDelayMs: 50 });
    assert.strictEqual(provider.scanning, false);
    const prom = provider.runScan();
    assert.strictEqual(provider.scanning, true);
    await prom;
    assert.strictEqual(provider.scanning, false);
    provider.dispose();
  });

  test('concurrent scan is rejected', async () => {
    const provider = makeProvider({ tscDelayMs: 100 });
    const first = provider.runScan();
    const second = provider.runScan();
    const results = await Promise.all([first, second]);
    // First should succeed, second should return empty (rejected)
    assert.strictEqual(results[1].length, 0);
    provider.dispose();
  });

  test('no projects fills lastScanErrors', async () => {
    const provider = makeProvider({ projects: [] });
    await provider.runScan();
    assert.ok(provider.lastScanErrors.length > 0);
    assert.ok(provider.lastScanErrors[0].message.includes('No tsconfig.json'));
    provider.dispose();
  });

  test('scanning returns to false after error', async () => {
    const provider = makeProvider({ projects: [] });
    assert.strictEqual(provider.scanning, false);
    await provider.runScan();
    assert.strictEqual(provider.scanning, false);
    provider.dispose();
  });

  test('TscScanError satisfies structural type', () => {
    const err: TscScanError = {
      tsconfigPath: '/workspace/tsconfig.json',
      message: 'config error',
    };
    assert.strictEqual(err.message, 'config error');
  });

  test('lastScanDurationMs is reported after scan', async () => {
    const provider = makeProvider({ tscDelayMs: 10 });
    assert.strictEqual(provider.lastScanDurationMs, 0);
    await provider.runScan();
    assert.ok(provider.lastScanDurationMs > 0);
    provider.dispose();
  });

  test('lastScanTiming is populated after scan', async () => {
    const provider = makeProvider({ tscDelayMs: 10 });
    await provider.runScan();
    const timing = provider.lastScanTiming;
    assert.ok(timing);
    assert.ok(timing!.totalMs > 0);
    assert.ok(timing!.resolveProjectsMs >= 0);
    assert.ok(timing!.tscRunsMs >= 0);
    assert.ok(timing!.parseMs >= 0);
    assert.ok(timing!.storeWriteMs >= 0);
    provider.dispose();
  });

  test('pendingRefresh queues a second scan after current completes', async () => {
    const provider = makeProvider({ tscDelayMs: 20 });
    // runScan with no delay means both get rejected but pendingRefresh is set
    const first = provider.runScan();
    // While scanning, trigger second ��� should set pendingRefresh
    const second = provider.runScan();
    await Promise.all([first, second]);
    // The pending refresh should have fired and completed
    assert.strictEqual(provider.scanning, false);
    provider.dispose();
  });

  test('getMemoryUsage returns process info', () => {
    const store = new ProblemStore();
    const provider = new TscDiagnosticProvider(store);
    const mem = provider.getMemoryUsage();
    assert.ok(mem);
    assert.ok(mem!.heapUsed > 0);
    assert.ok(mem!.heapTotal > 0);
    provider.dispose();
  });

  test('constructor accepts refreshDebounceMs', () => {
    const store = new ProblemStore();
    const provider = new TscDiagnosticProvider(store, { refreshDebounceMs: 500 });
    assert.ok(provider);
    provider.dispose();
  });

  test('ScanTiming satisfies structural type', () => {
    const t: ScanTiming = {
      totalMs: 100, resolveProjectsMs: 10, tscRunsMs: 80, parseMs: 5, storeWriteMs: 5,
    };
    assert.strictEqual(t.totalMs, 100);
  });

  test('currentProject is undefined before scan', () => {
    const provider = makeProvider();
    assert.strictEqual(provider.currentProject, undefined);
    provider.dispose();
  });

  test('currentProject is undefined after scan', async () => {
    const provider = makeProvider({ tscDelayMs: 10 });
    await provider.runScan();
    assert.strictEqual(provider.currentProject, undefined);
    provider.dispose();
  });

  test('enabled is true by default', () => {
    const provider = makeProvider();
    assert.strictEqual(provider.enabled, true);
    provider.dispose();
  });

  test('updateConfig changes enabled and timeout', () => {
    const provider = makeProvider();
    provider.updateConfig({ enabled: false, autoScan: true, scanOnStartup: false, timeout: 5000, useWorkspaceVersion: false, maxConcurrentScans: 1 });
    assert.strictEqual(provider.enabled, false);
    provider.dispose();
  });

  test('disabled scan returns empty', async () => {
    const provider = makeProvider();
    provider.updateConfig({ enabled: false, autoScan: true, scanOnStartup: false, timeout: 120000, useWorkspaceVersion: true, maxConcurrentScans: 1 });
    const result = await provider.runScan();
    assert.strictEqual(result.length, 0);
    provider.dispose();
  });
});