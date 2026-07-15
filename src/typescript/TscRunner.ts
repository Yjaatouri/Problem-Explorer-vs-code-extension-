import * as path from 'path';
import * as cp from 'child_process';

export interface TscRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly executionTimeMs: number;
  readonly cancelled: boolean;
  readonly tsconfigPath: string;
}

export interface TscRunOptions {
  readonly typescriptPath: string;
  readonly tsconfigPath: string;
  readonly signal?: AbortSignal;
}

export interface TscProcess {
  stdout: { on(event: 'data', listener: (chunk: string) => void): void };
  stderr: { on(event: 'data', listener: (chunk: string) => void): void };
  on(event: 'close', listener: (code: number | null) => void): void;
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
    const tscScript = path.join(options.typescriptPath, 'lib', 'tsc.js');
    const args = [
      tscScript,
      '--noEmit',
      '--pretty', 'false',
      '--project', options.tsconfigPath,
    ];

    const child = this.delegate.spawn('node', args);

    const startTime = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    return new Promise<TscRunResult>((resolve) => {
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

      child.on('close', (code: number | null) => {
        const executionTimeMs = Date.now() - startTime;
        const cancelled = code === null;

        if (options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }

        resolve({
          exitCode: code,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          executionTimeMs,
          cancelled,
          tsconfigPath: options.tsconfigPath,
        });
      });
    });
  }
}
