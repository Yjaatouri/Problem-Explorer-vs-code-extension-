import * as path from 'path';
import * as cp from 'child_process';
import { NPX_SENTINEL } from './ProjectResolver';

export const DEFAULT_TSC_TIMEOUT_MS = 120_000;

export interface TscRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly executionTimeMs: number;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly error?: string;
  readonly tsconfigPath: string;
}

export interface TscRunOptions {
  readonly typescriptPath: string;
  readonly tsconfigPath: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TscProcess {
  stdout: { on(event: 'data', listener: (chunk: string) => void): void };
  stderr: { on(event: 'data', listener: (chunk: string) => void): void };
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: string): void;
}

export interface TscRunnerDelegate {
  spawn(command: string, args: string[]): TscProcess;
}

const defaultDelegate: TscRunnerDelegate = {
  spawn: (command, args) => cp.spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  }) as unknown as TscProcess,
};

export class TscRunner {
  private readonly delegate: TscRunnerDelegate;

  constructor(delegate?: TscRunnerDelegate) {
    this.delegate = delegate ?? defaultDelegate;
  }

  async run(options: TscRunOptions): Promise<TscRunResult> {
    const useNpx = options.typescriptPath === NPX_SENTINEL;

    let command: string;
    let tscArgs: string[];

    if (useNpx) {
      command = 'npx';
      tscArgs = [
        '--package', 'typescript',
        'tsc',
        '--noEmit',
        '--pretty', 'false',
        '--project', options.tsconfigPath,
      ];
    } else {
      const tscScript = path.join(options.typescriptPath, 'lib', 'tsc.js');
      command = 'node';
      tscArgs = [
        tscScript,
        '--noEmit',
        '--pretty', 'false',
        '--project', options.tsconfigPath,
      ];
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TSC_TIMEOUT_MS;
    const startTime = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    return new Promise<TscRunResult>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let childResolved = false;

      const finish = (result: TscRunResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        resolve(result);
      };

      let child: TscProcess;
      try {
        child = this.delegate.spawn(command, tscArgs);
      } catch (err: unknown) {
        finish({
          exitCode: null,
          stdout: '',
          stderr: '',
          executionTimeMs: Date.now() - startTime,
          cancelled: false,
          timedOut: false,
          error: err instanceof Error ? err.message : String(err),
          tsconfigPath: options.tsconfigPath,
        });
        return;
      }

      child.stdout.on('data', (chunk: string) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: string) => {
        stderrChunks.push(chunk);
      });

      const abortHandler = (): void => {
        child.kill();
      };

      if (options.signal) {
        if (options.signal.aborted) {
          child.kill();
        } else {
          options.signal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      child.on('error', (err: Error) => {
        if (childResolved) return;
        finish({
          exitCode: null,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          executionTimeMs: Date.now() - startTime,
          cancelled: false,
          timedOut: false,
          error: err.message,
          tsconfigPath: options.tsconfigPath,
        });
      });

      child.on('close', (code: number | null) => {
        childResolved = true;
        const executionTimeMs = Date.now() - startTime;

        if (options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }

        finish({
          exitCode: code,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          executionTimeMs,
          cancelled: code === null,
          timedOut: false,
          tsconfigPath: options.tsconfigPath,
        });
      });

      timeoutHandle = setTimeout(() => {
        child.kill();
        finish({
          exitCode: null,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          executionTimeMs: Date.now() - startTime,
          cancelled: false,
          timedOut: true,
          error: `Timeout after ${timeoutMs}ms`,
          tsconfigPath: options.tsconfigPath,
        });
      }, timeoutMs);
    });
  }
}
