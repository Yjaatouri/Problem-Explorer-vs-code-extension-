import * as assert from 'assert';
import { TscRunner, TscProcess, TscRunnerDelegate, TscRunResult } from '../../typescript/TscRunner';
import { NPX_SENTINEL } from '../../typescript/ProjectResolver';

type DataListener = (chunk: string) => void;
type CloseListener = (code: number | null) => void;
type ErrorListener = (err: Error) => void;

function fakeProcess(overrides: {
  exitCode?: number | null;
  stdoutData?: string;
  stderrData?: string;
  closeDelayMs?: number;
  errorOnSpawn?: boolean;
}): TscProcess {
  const closeListeners: CloseListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const stdoutListeners: DataListener[] = [];
  const stderrListeners: DataListener[] = [];

  const process: TscProcess = {
    stdout: {
      on: (event: 'data', listener: DataListener) => {
        if (event === 'data') {
          stdoutListeners.push(listener);
        }
      },
    },
    stderr: {
      on: (event: 'data', listener: DataListener) => {
        if (event === 'data') {
          stderrListeners.push(listener);
        }
      },
    },
    on: (event: 'close' | 'error', listener: CloseListener | ErrorListener) => {
      if (event === 'close') {
        closeListeners.push(listener as CloseListener);
      } else if (event === 'error') {
        errorListeners.push(listener as ErrorListener);
      }
    },
    kill: () => {},
  };

  setImmediate(() => {
    if (overrides.errorOnSpawn) {
      for (const listener of errorListeners) {
        listener(new Error('ENOENT: spawn node ENOENT'));
      }
      return;
    }
    if (overrides.stdoutData) {
      for (const listener of stdoutListeners) {
        listener(overrides.stdoutData);
      }
    }
    if (overrides.stderrData) {
      for (const listener of stderrListeners) {
        listener(overrides.stderrData);
      }
    }
    const delay = overrides.closeDelayMs ?? 0;
    setTimeout(() => {
      for (const listener of closeListeners) {
        listener(overrides.exitCode ?? 0);
      }
    }, delay);
  });

  return process;
}

function makeDelegate(spawnResult: TscProcess): TscRunnerDelegate {
  let callCount = 0;
  let lastCommand = '';
  let lastArgs: string[] = [];

  const delegate: TscRunnerDelegate = {
    spawn: (command: string, args: string[]) => {
      callCount++;
      lastCommand = command;
      lastArgs = args;
      return spawnResult;
    },
  };

  return Object.assign(delegate, { callCount: () => callCount, lastCommand: () => lastCommand, lastArgs: () => lastArgs });
}

suite('TscRunner', () => {
  test('spawns node with tsc.js and expected args', async () => {
    const proc = fakeProcess({ exitCode: 0 });
    let captured: { command: string; args: string[] } | undefined;
    const delegate: TscRunnerDelegate = {
      spawn: (command, args) => {
        captured = { command, args };
        return proc;
      },
    };
    const runner = new TscRunner(delegate);

    await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.ok(captured);
    assert.strictEqual(captured!.command, 'node');
    assert.ok(captured!.args[0].endsWith('tsc.js'));
    assert.ok(captured!.args.includes('--noEmit'));
    assert.ok(captured!.args.includes('--pretty'));
    assert.ok(captured!.args.includes('false'));
    assert.ok(captured!.args.includes('--project'));
    assert.ok(captured!.args.includes('/workspace/tsconfig.json'));
  });

  test('spawns npx with --package typescript when typescriptPath is NPX_SENTINEL', async () => {
    const proc = fakeProcess({ exitCode: 0, closeDelayMs: 5 });
    let captured: { command: string; args: string[] } | undefined;
    const delegate: TscRunnerDelegate = {
      spawn: (command, args) => {
        captured = { command, args };
        return proc;
      },
    };
    const runner = new TscRunner(delegate);

    await runner.run({
      typescriptPath: NPX_SENTINEL,
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.ok(captured);
    assert.strictEqual(captured!.command, 'npx');
    assert.ok(captured!.args.includes('--package'));
    assert.ok(captured!.args.includes('typescript'));
    assert.ok(captured!.args.includes('tsc'));
    assert.ok(captured!.args.includes('--noEmit'));
    assert.ok(captured!.args.includes('--project'));
    assert.ok(captured!.args.includes('/workspace/tsconfig.json'));
  });

  test('returns exit code 0 on success', async () => {
    const delegate = makeDelegate(fakeProcess({ exitCode: 0 }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.cancelled, false);
  });

  test('returns non-zero exit code on compilation error', async () => {
    const delegate = makeDelegate(fakeProcess({ exitCode: 2 }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.strictEqual(result.exitCode, 2);
  });

  test('captures stdout', async () => {
    const delegate = makeDelegate(fakeProcess({
      exitCode: 0,
      stdoutData: 'No errors found\n',
    }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.strictEqual(result.stdout, 'No errors found\n');
  });

  test('captures stderr', async () => {
    const delegate = makeDelegate(fakeProcess({
      exitCode: 1,
      stderrData: 'src/file.ts(5,10): error TS2322: Type "number" is not assignable to type "string"\n',
    }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.strictEqual(result.stderr.includes('error TS2322'), true);
    assert.strictEqual(result.stderr.includes('src/file.ts'), true);
  });

  test('captures execution time', async () => {
    const delegate = makeDelegate(fakeProcess({
      exitCode: 0,
      closeDelayMs: 50,
    }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.ok(result.executionTimeMs >= 50, `expected >= 50ms, got ${result.executionTimeMs}`);
  });

  test('returns the tsconfigPath in result', async () => {
    const delegate = makeDelegate(fakeProcess({ exitCode: 0 }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.strictEqual(result.tsconfigPath, '/workspace/tsconfig.json');
  });

  test('supports cancellation via AbortSignal', async () => {
    const proc = fakeProcess({ exitCode: null, closeDelayMs: 1000 });
    const delegate: TscRunnerDelegate = {
      spawn: () => proc,
    };
    const runner = new TscRunner(delegate);

    const ac = new AbortController();
    const promise = runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
      signal: ac.signal,
    });

    ac.abort();

    const result = await promise;
    assert.strictEqual(result.cancelled, true);
  });

  test('handles pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();

    const delegate = makeDelegate(fakeProcess({ exitCode: 0 }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
      signal: ac.signal,
    });

    assert.strictEqual(result.cancelled, true);
  });

  test('large stdout does not overflow', async () => {
    const largeOutput = 'x'.repeat(100000);
    const delegate = makeDelegate(fakeProcess({
      exitCode: 0,
      stdoutData: largeOutput,
    }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.strictEqual(result.stdout.length, 100000);
  });

  test('TscRunResult satisfies structural type', () => {
    const result: TscRunResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      executionTimeMs: 100,
      cancelled: false,
      timedOut: false,
      tsconfigPath: '/workspace/tsconfig.json',
    };
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.cancelled, false);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.executionTimeMs, 100);
  });

  test('handles spawn error event', async () => {
    const delegate = makeDelegate(fakeProcess({ errorOnSpawn: true }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.ok(result.error);
    assert.ok(result.error!.includes('ENOENT'));
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.cancelled, false);
  });

  test('handles spawn throw', async () => {
    const delegate: TscRunnerDelegate = {
      spawn: () => { throw new Error('ENOENT: spawn node ENOENT'); },
    };
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
    });

    assert.ok(result.error);
    assert.ok(result.error!.includes('ENOENT'));
  });

  test('times out after timeoutMs', async () => {
    const delegate = makeDelegate(fakeProcess({
      exitCode: 0,
      closeDelayMs: 50000,
    }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
      timeoutMs: 50,
    });

    assert.strictEqual(result.timedOut, true);
    assert.ok(result.error);
    assert.ok(result.error!.includes('Timeout'));
  });

  test('does not time out when process completes before timeout', async () => {
    const delegate = makeDelegate(fakeProcess({
      exitCode: 0,
      closeDelayMs: 5,
    }));
    const runner = new TscRunner(delegate);

    const result = await runner.run({
      typescriptPath: '/workspace/node_modules/typescript',
      tsconfigPath: '/workspace/tsconfig.json',
      timeoutMs: 5000,
    });

    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.exitCode, 0);
  });

  test('import TscRunner is a class', () => {
    assert.strictEqual(typeof TscRunner, 'function');
  });
});
