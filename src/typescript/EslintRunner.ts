import { spawn, SpawnOptions } from 'child_process';
import { EslintOutputParser, EslintDiagnostic } from './EslintOutputParser';
export type { EslintDiagnostic };

export interface EslintRunOptions {
  cwd: string;
  eslintPath?: string;
  configPath?: string;
  ext?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EslintRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'];

export class EslintRunner {
  private readonly parser = new EslintOutputParser();

  async run(options: EslintRunOptions): Promise<EslintRunResult> {
    const {
      cwd,
      eslintPath = 'eslint',
      configPath,
      ext = DEFAULT_EXTENSIONS,
      signal,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    const args = ['--format', 'json', '--no-error-on-unmatched-pattern'];

    if (configPath) {
      args.push('--config', configPath);
    }

    args.push(...ext.map((e) => `**/*${e}`));

    const spawnOpts: SpawnOptions = {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
    };

    return new Promise<EslintRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let killed = false;

      const child = spawn(eslintPath, args, spawnOpts);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        cancelled = true;
        killed = true;
        child.kill('SIGTERM');
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort);
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err: Error) => {
        cleanup();
        if (!killed) {
          resolve({
            exitCode: null,
            stdout,
            stderr,
            timedOut: false,
            cancelled: false,
            error: err.message,
          });
        }
      });

      child.on('close', (code: number | null) => {
        cleanup();
        if (!killed) {
          resolve({
            exitCode: code,
            stdout,
            stderr,
            timedOut: false,
            cancelled: false,
          });
        } else if (timedOut) {
          resolve({
            exitCode: code,
            stdout,
            stderr,
            timedOut: true,
            cancelled: false,
            error: 'ESLint timed out',
          });
        } else if (cancelled) {
          resolve({
            exitCode: code,
            stdout,
            stderr,
            timedOut: false,
            cancelled: true,
            error: 'ESLint cancelled',
          });
        }
      });
    });
  }

  parseOutput(output: string): EslintDiagnostic[] {
    return this.parser.parse(output);
  }
}