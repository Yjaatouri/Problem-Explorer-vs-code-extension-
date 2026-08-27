import { spawn, SpawnOptions } from 'child_process';

export interface OxlintRunOptions {
  readonly cwd: string;
  /** Path to the oxlint CLI script (e.g. `<pkg>/bin/oxlint`). Executed via the Node host. */
  readonly script?: string;
  readonly configPath?: string;
  readonly filePath?: string;
  readonly timeoutMs?: number;
}

export interface OxlintDiagnostic {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code: string;
  readonly url?: string;
  readonly help?: string;
}

export interface OxlintRunResult {
  readonly exitCode: number | null;
  readonly diagnostics: readonly OxlintDiagnostic[];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OxlintRunner {
  async run(options: OxlintRunOptions): Promise<OxlintRunResult> {
    const {
      cwd,
      script,
      configPath,
      filePath,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    if (!script) {
      return {
        exitCode: null,
        diagnostics: [],
        timedOut: false,
        cancelled: false,
        error: 'Oxlint script not resolved',
      };
    }

    const args = [script, '--format', 'json'];

    // oxlint does not exclude node_modules by default in non-git directories,
    // so always pass explicit excludes. Keep in parity with the resolver's
    // hasJsTsFiles() exclude list.
    args.push('--ignore-pattern', '**/node_modules/**');
    args.push('--ignore-pattern', '**/.git/**');
    args.push('--ignore-pattern', '**/dist/**');
    args.push('--ignore-pattern', '**/build/**');
    args.push('--ignore-pattern', '**/.next/**');
    args.push('--ignore-pattern', '**/target/**');

    if (configPath) {
      args.push('--config', configPath);
    }

    if (filePath) {
      args.push(filePath);
    }

    // oxlint is distributed as a Node ESM CLI (`bin/oxlint`). Spawn it through
    // the host Node runtime. Inside the VS Code extension host, process.execPath
    // is the Electron binary; ELECTRON_RUN_AS_NODE=1 makes it behave as Node,
    // so the script runs without requiring a separately installed Node.
    // This also avoids all .cmd/sh wrapper issues on Windows (no shell: true).
    const spawnOpts: SpawnOptions = {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };

    return new Promise<OxlintRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(process.execPath, args, spawnOpts);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        cleanup();
        if (settled) return;
        settled = true;
        resolve({
          exitCode: null,
          diagnostics: [],
          timedOut: false,
          cancelled: false,
          error: err.message,
        });
      });

      child.on('close', (code: number | null) => {
        cleanup();
        if (settled) return;
        settled = true;

        if (timedOut) {
          resolve({
            exitCode: code,
            diagnostics: [],
            timedOut: true,
            cancelled: false,
            error: 'Oxlint timed out',
          });
          return;
        }

        let diagnostics: OxlintDiagnostic[] = [];
        if (stdout.trim()) {
          try {
            const result = JSON.parse(stdout);
            if (result.diagnostics && Array.isArray(result.diagnostics)) {
              diagnostics = result.diagnostics.map((d: any) => ({
                filePath: d.filename ?? d.filePath ?? '',
                line: d.labels?.[0]?.span?.line ?? d.line ?? 1,
                column: d.labels?.[0]?.span?.column ?? d.column ?? 1,
                endLine: d.labels?.[0]?.span?.endLine,
                endColumn: d.labels?.[0]?.span?.endColumn,
                severity: d.severity === 'error' ? 'error' : 'warning',
                message: d.message ?? '',
                code: d.code ?? '',
                url: d.url,
                help: d.help,
              }));
            }
          } catch {
            if (code !== 0 && stderr.trim()) {
              resolve({
                exitCode: code,
                diagnostics: [],
                timedOut: false,
                cancelled: false,
                error: stderr.trim().substring(0, 500),
              });
              return;
            }
          }
        } else if (code !== 0 && stderr.trim()) {
          resolve({
            exitCode: code,
            diagnostics: [],
            timedOut: false,
            cancelled: false,
            error: stderr.trim().substring(0, 500),
          });
          return;
        }

        resolve({
          exitCode: code,
          diagnostics,
          timedOut: false,
          cancelled: false,
        });
      });
    });
  }
}
