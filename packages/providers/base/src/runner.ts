// Executable discovery and execution with one child.
//
// The one place in the provider base that spawns child processes; everything
// else works on strings. Handles Windows PATHEXT retries, output caps, and
// timeouts, and reminds providers to call `disposeAll()` on shutdown.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // safety cap on runaway output

/** Result of one child process execution. `code` may be null when the child never spawned or was killed. */
export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** Binary was not found on PATH (ENOENT at spawn). */
  readonly missing: boolean;
  /** Killed after `timeoutMs` elapsed. */
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const activeChildren = new Set<ChildProcess>();

/**
 * Kill every in-flight child. Called by the engine on shutdown; individual
 * providers / host processes should call this in their own shutdown too.
 */
export function disposeAllChildren(): void {
  for (const child of activeChildren) {
    child.kill();
  }
  activeChildren.clear();
}

export function activeChildCount(): number {
  return activeChildren.size;
}

async function runChild(
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ stdout: '', stderr: '', code: null, missing: false, timedOut: false });
      return;
    }

    activeChildren.add(child);
    child.on('exit', () => activeChildren.delete(child));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const append = (side: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const out = side === 'stdout' ? stdout : stderr;
      if (Buffer.byteLength(out) + chunk.length <= MAX_OUTPUT_BYTES) {
        if (side === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      } else if (side === 'stderr' && !stderr.endsWith('[output truncated]')) {
        stderr += '\n[output truncated]';
      }
    };

    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: err.message,
        code: null,
        missing: err.code === 'ENOENT',
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, missing: false, timedOut });
    });
  });
}

/**
 * Execute `argv[0]` with the remaining args (and cwd/env options).
 *
 * Windows note: `node:child_process` cannot execute PATHEXT shims
 * (e.g. a `node_modules/.bin/tsc.cmd` referenced as `tsc`) — CreateProcess
 * does not apply PATHEXT. When a bare name fails with ENOENT on Windows we
 * retry through `cmd.exe /d /s /c` with the `.cmd` shim, which is exactly
 * what pnpm/npm ship in `.bin`. Providers therefore work identically on
 * both platforms with zero configuration.
 */
export async function runExecutable(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const [bin, ...args] = argv;
  if (bin === undefined) {
    return {
      stdout: '',
      stderr: 'empty command array',
      code: null,
      missing: false,
      timedOut: false,
    };
  }

  const result = await runChild(bin, args, options);

  if (result.missing && process.platform === 'win32') {
    // A bare name may be a PATH shim (node_modules/.bin/*.cmd).
    if (onPath(bin)) {
      const retry = await winCmdRun(`${bin}.cmd`, args, options);
      if (!retry.missing) {
        return retry;
      }
    }
  }
  return result;
}

function quoteWinArg(arg: string): string {
  return /[\s"&^|]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** True when `bin` (or its .cmd shim) is resolvable from the PATH */
function onPath(bin: string): boolean {
  if (existsSync(bin)) {
    return true;
  }
  const candidates = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const dir of (process.env.PATH ?? '').split(';')) {
    for (const candidate of candidates) {
      if (dir.length > 0 && existsSync(`${dir}\\${candidate}`)) {
        return true;
      }
    }
  }
  return false;
}

/** Run through cmd.exe: the only reliable way to execute `.cmd` shims. */
async function winCmdRun(
  shim: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const comspec = process.env.COMSPEC ?? 'cmd.exe';
  const command = [shim, ...args].map(quoteWinArg).join(' ');
  return runChild(comspec, ['/d', '/s', '/c', command], options);
}
