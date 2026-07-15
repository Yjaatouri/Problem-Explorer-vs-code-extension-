import * as assert from 'assert';

import { ProblemStore } from '../../store/ProblemStore';
import { TscDiagnosticProvider } from '../../providers/TscDiagnosticProvider';
import { ProjectResolver, TypeScriptProject } from '../../typescript/ProjectResolver';
import { TscRunner, TscRunnerDelegate, TscProcess } from '../../typescript/TscRunner';
import { TscOutputParser } from '../../typescript/TscOutputParser';
import { measure, formatResult } from '../../benchmark/benchmark';

function makeTscProcess(output: string, exitCode: number, delayMs: number): TscProcess {
  const dataListeners: Array<(chunk: string) => void> = [];
  const closeListeners: Array<(code: number | null) => void> = [];

  setImmediate(() => {
    for (const l of dataListeners) l(output);
    setTimeout(() => {
      for (const l of closeListeners) l(exitCode);
    }, delayMs);
  });

  return {
    stdout: { on: (_e: 'data', l: (chunk: string) => void) => { dataListeners.push(l); } },
    stderr: { on: (_e: 'data', _l: (chunk: string) => void) => {} },
    on: (_e: 'close' | 'error', l: ((code: number | null) => void) | ((err: Error) => void)) => {
      if (_e === 'close') { closeListeners.push(l as (code: number | null) => void); }
    },
    kill: () => {},
  };
}

function makeRunner(output: string, exitCode = 0, delayMs = 0): TscRunner {
  const delegate: TscRunnerDelegate = {
    spawn: () => makeTscProcess(output, exitCode, delayMs),
  };
  return new TscRunner(delegate);
}

function makeResolver(projects: TypeScriptProject[]): ProjectResolver {
  return new (class extends ProjectResolver {
    async resolveAll() { return projects; }
  })();
}

function largeOutput(numErrors: number): string {
  const lines: string[] = [];
  for (let i = 0; i < numErrors; i++) {
    const file = `src/file${i}.ts`;
    const line = (i % 100) + 1;
    const col = (i % 50) + 1;
    const sev = i % 3 === 0 ? 'error' : 'warning';
    const code = i % 3 === 0 ? 'TS2322' : 'TS6133';
    lines.push(`${file}(${line},${col}): ${sev} ${code}: Diagnostic message ${i}.`);
  }
  return lines.join('\n');
}

function mbUsed(): number {
  const mem = process.memoryUsage();
  return Math.round(mem.heapUsed / 1024 / 1024);
}

suite('TscBenchmark', () => {
  const results: string[] = [];

  teardown(() => {
    if (results.length > 0) {
      console.log('=== TSC BENCHMARK RESULTS ===');
      for (const r of results) console.log(r);
      console.log('=== END BENCHMARK RESULTS ===');
    }
  });

  test('1: Startup time', () => {
    const r = measure('TscDiagnosticProvider creation', () => {
      const store = new ProblemStore();
      const resolver = makeResolver([]);
      const runner = makeRunner('');
      const parser = new TscOutputParser();
      const provider = new TscDiagnosticProvider(store, resolver, runner, parser);
      provider.dispose();
    }, 1000);
    results.push(formatResult(r));
    assert.ok(r.avgUs >= 0);
  });

  test('2a: Scan duration - single tsconfig (10 errors)', async () => {
    const store = new ProblemStore();
    const resolver = makeResolver([{
      tsconfigPath: '/workspace/tsconfig.json',
      projectRoot: '/workspace',
      typescriptPath: '/workspace/node_modules/typescript',
      typescriptVersion: '5.5.0',
    }]);
    const runner = makeRunner(largeOutput(10), 0, 1);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('Scan 10 errors', () => {
      provider.refresh();
    }, 100);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('2b: Scan duration - single tsconfig (1000 errors)', async () => {
    const store = new ProblemStore();
    const resolver = makeResolver([{
      tsconfigPath: '/workspace/tsconfig.json',
      projectRoot: '/workspace',
      typescriptPath: '/workspace/node_modules/typescript',
      typescriptVersion: '5.5.0',
    }]);
    const runner = makeRunner(largeOutput(1000), 0, 5);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('Scan 1000 errors', () => {
      provider.refresh();
    }, 50);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('3a: Scan duration - 5 tsconfigs', async () => {
    const store = new ProblemStore();
    const projects: TypeScriptProject[] = [];
    for (let i = 0; i < 5; i++) {
      projects.push({
        tsconfigPath: `/workspace/packages/pkg${i}/tsconfig.json`,
        projectRoot: `/workspace/packages/pkg${i}`,
        typescriptPath: '/workspace/node_modules/typescript',
        typescriptVersion: '5.5.0',
      });
    }
    const resolver = makeResolver(projects);
    const runner = makeRunner(largeOutput(5), 0, 1);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('Scan 5 tsconfigs', () => {
      provider.refresh();
    }, 50);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('3b: Scan duration - 10 tsconfigs', async () => {
    const store = new ProblemStore();
    const projects: TypeScriptProject[] = [];
    for (let i = 0; i < 10; i++) {
      projects.push({
        tsconfigPath: `/workspace/packages/pkg${i}/tsconfig.json`,
        projectRoot: `/workspace/packages/pkg${i}`,
        typescriptPath: '/workspace/node_modules/typescript',
        typescriptVersion: '5.5.0',
      });
    }
    const resolver = makeResolver(projects);
    const runner = makeRunner(largeOutput(3), 0, 1);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('Scan 10 tsconfigs', () => {
      provider.refresh();
    }, 50);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('4: Missing TypeScript scenario', async () => {
    const store = new ProblemStore();
    const resolver = makeResolver([]);
    const runner = makeRunner('');
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('No TypeScript (empty projects)', () => {
      provider.refresh();
    }, 100);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('5: Compiler errors (nonzero exit code)', async () => {
    const store = new ProblemStore();
    const resolver = makeResolver([{
      tsconfigPath: '/workspace/tsconfig.json',
      projectRoot: '/workspace',
      typescriptPath: '/workspace/node_modules/typescript',
      typescriptVersion: '5.5.0',
    }]);
    const runner = makeRunner(largeOutput(50), 2, 1);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('Compiler errors (exit=2, 50 diags)', () => {
      provider.refresh();
    }, 50);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('6: Invalid tsconfig (runner throws)', async () => {
    const store = new ProblemStore();
    const resolver = makeResolver([{
      tsconfigPath: '/workspace/bad.json',
      projectRoot: '/workspace',
      typescriptPath: '/workspace/node_modules/typescript',
      typescriptVersion: '5.5.0',
    }]);
    const delegate: TscRunnerDelegate = {
      spawn: () => { throw new Error('ENOENT'); },
    };
    const runner = new TscRunner(delegate);
    const parser = new TscOutputParser();
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    const r = measure('Invalid tsconfig (throw)', () => {
      provider.refresh();
    }, 50);
    results.push(formatResult(r));
    provider.dispose();
    assert.ok(r.avgUs >= 0);
  });

  test('7: Memory usage', () => {
    const memBefore = mbUsed();

    const stores: ProblemStore[] = [];
    const providers: TscDiagnosticProvider[] = [];
    for (let i = 0; i < 100; i++) {
      const store = new ProblemStore();
      stores.push(store);
      const resolver = makeResolver([{
        tsconfigPath: `/workspace/p${i}/tsconfig.json`,
        projectRoot: `/workspace/p${i}`,
        typescriptPath: '/workspace/node_modules/typescript',
        typescriptVersion: '5.5.0',
      }]);
      const runner = makeRunner(largeOutput(100), 0, 0);
      const parser = new TscOutputParser();
      const provider = new TscDiagnosticProvider(store, resolver, runner, parser);
      providers.push(provider);
    }

    const memAfter = mbUsed();
    const perInstance = (memAfter - memBefore);
    results.push(`Memory (100 instances): heap ${memBefore}MB → ${memAfter}MB (${perInstance}MB delta, ~${(perInstance / 100 * 1024).toFixed(0)}KB each)`);

    for (const p of providers) p.dispose();
    assert.ok(memAfter >= memBefore);
  });

  test('8: Parse throughput', () => {
    const parser = new TscOutputParser();
    const output = largeOutput(5000);

    const r = measure('Parse 5000 diagnostics', () => {
      parser.parse(output);
    }, 200);
    results.push(formatResult(r));
    assert.ok(r.avgUs >= 0);
  });
});
