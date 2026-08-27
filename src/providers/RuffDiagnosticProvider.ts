// Ruff diagnostics via `ruff check --output-format json`.

import { Event, EventEmitter, Uri, workspace } from 'vscode';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemSeverity, ProblemState, RuffConfig } from '../core/types';
import * as path from 'path';

/**
 * Map a Ruff diagnostic to ProblemSeverity (None=0, Info=1, Warning=2, Error=3).
 * Ruff's JSON has no reliable severity field, so infer from rule-code prefixes:
 * convention/refactor/warning families (W/I/R/C/P/D/ANN/B0/TCH…) are warnings;
 * everything else (F, E999 syntax, S safety, …) is an error.
 */
export function severityOf(code: string, severity?: 'error' | 'warning' | 'info'): ProblemSeverity {
  if (severity !== undefined) {
    switch (severity) {
      case 'error': return ProblemSeverity.Error;
      case 'warning': return ProblemSeverity.Warning;
      case 'info': return ProblemSeverity.Info;
    }
  }
  if (/^[WIRCPD]/.test(code) || /^(ANN|B0|TCH)/.test(code)) return ProblemSeverity.Warning;
  return ProblemSeverity.Error;
}

export function parseRuffJson(stdout: string): { file: string; line: number | undefined; column: number | undefined; severity: number; message: string; code: string }[] {
  let items: any[];
  try {
    items = JSON.parse(stdout) as any[];
  } catch {
    return [];
  }
  const issues: { file: string; line: number | undefined; column: number | undefined; severity: number; message: string; code: string }[] = [];
  for (const item of items) {
    const file = item.file ?? item.filename;
    if (!file || file.length === 0) continue;
    issues.push({
      file,
      line: item.line ?? item.location?.row,
      column: item.column ?? item.location?.column,
      severity: severityOf(item.code, item.severity),
      message: item.message,
      code: item.code,
    });
  }
  return issues;
}

export class RuffDiagnosticProvider {
  readonly name = 'ruff';
  readonly capabilities = {
    extensions: ['.py', '.pyi'] as const,
    realtime: false,
    manualScan: true,
    startupScan: true,
    fullWorkspace: true,
  };
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate: Event<Uri[]> = this._onDidUpdate.event;
  private readonly _onDidProgressScan = new EventEmitter<any>();
  readonly onDidProgressScan: Event<any> = this._onDidProgressScan.event;
  private _disposed = false;
  private _scanning = false;
  private _config: RuffConfig;

  get store(): ProblemStore { return this._store; }
  get scanning(): boolean { return this._scanning; }
  get enabled(): boolean { return this._config.enabled; }
  get autoScan(): boolean { return this._config.autoScan; }

  constructor(store: ProblemStore, config: RuffConfig) {
    this._store = store;
    this._config = config;
  }

  updateConfig(config: RuffConfig): void {
    this._config = config;
  }

  async initialize(): Promise<void> {
    if (!this._config.enabled) return;
    if (!this._config.scanOnStartup) return;
    const changed = await this.runScan();
    if (changed.length > 0) this._onDidUpdate.fire(changed);
  }

  start(): void {}
  stop(): void {}

  async refresh(): Promise<void> {
    if (!this._config.enabled) return;
    const changed = await this.runScan();
    if (!this._disposed && changed.length > 0) this._onDidUpdate.fire(changed);
  }

  dispose(): void { this._disposed = true; }
  releaseOwnership(): void {}

  private runRuff(cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = require('node:child_process').spawn('ruff', ['check', '--output-format', 'json', '.'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '', stderr = '';
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number | null) => {
        if (code === 0 || code === 1) resolve({ stdout, stderr });
        else reject(new Error(`ruff exited with code ${code}: ${stderr}`));
      });
      proc.on('error', (err: Error) => reject(err));
    });
  }

  private async findFoldersWithRuff(folders: readonly { uri: Uri; name: string }[]): Promise<{ uri: Uri; name: string }[]> {
    const result: { uri: Uri; name: string }[] = [];

    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;
      let hasConfig = false;
      for (const config of ['pyproject.toml', 'ruff.toml', '.ruff.toml']) {
        try { await require('fs/promises').access(path.join(folderPath, config)); hasConfig = true; break; } catch {}
      }
      if (hasConfig) result.push(folder);
    }
    return result;
  }

  async runScan(): Promise<Uri[]> {
    if (this._scanning) return [];
    if (!this._config.enabled) return [];
    this._scanning = true;

    try {
      const workspaceFolders = workspace.workspaceFolders ?? [];
      if (workspaceFolders.length === 0) return [];

      const allDiagnostics = new Map<string, Array<{ uri: Uri; line: number | undefined; column: number | undefined; severity: number; message: string; code: string }>>();

      const foldersWithRuff = await this.findFoldersWithRuff(workspace.workspaceFolders ?? []);
      if (foldersWithRuff.length === 0) return [];

      for (const folder of foldersWithRuff) {
        const result = await this.runRuff(folder.uri.fsPath);
        if (!result.stdout) continue;

        const diagnostics = parseRuffJson(result.stdout);
        for (const diag of diagnostics) {
          const uri = Uri.file(path.resolve(folder.uri.fsPath, diag.file));
          const key = uri.toString();
          const existing = allDiagnostics.get(key) ?? [];
          existing.push({ uri: Uri.file(path.resolve(folder.uri.fsPath, diag.file)), line: diag.line, column: diag.column, severity: diag.severity, message: diag.message, code: diag.code });
          allDiagnostics.set(uri.toString(), existing);
        }
      }

      const changed = this.writeToStore(allDiagnostics);
      return changed;
    } finally {
      this._scanning = false;
    }
  }

  private writeToStore(diagnostics: Map<string, Array<{ uri: Uri; line: number | undefined; column: number | undefined; severity: number; message: string; code: string }>>): Uri[] {
    const changed: Uri[] = [];

    for (const [uriString, fileDiags] of diagnostics) {
      const state = this.aggregateFileState(fileDiags);
      const uri = Uri.parse(uriString);
      const result = this._store.set(uri, state, 'ruff');
      if (result) changed.push(uri);
    }

    return changed;
  }

  private aggregateFileState(diagnostics: Array<{ uri: Uri; line: number | undefined; column: number | undefined; severity: number; message: string; code: string }>): ProblemState {
    let errorCount = 0, warningCount = 0, infoCount = 0;

    for (const diag of diagnostics) {
      if (diag.severity === ProblemSeverity.Error) errorCount++;
      else if (diag.severity === ProblemSeverity.Warning) warningCount++;
      else if (diag.severity === ProblemSeverity.Info) infoCount++;
    }

    let severity = ProblemSeverity.None;
    if (errorCount > 0) severity = ProblemSeverity.Error;
    else if (warningCount > 0) severity = ProblemSeverity.Warning;
    else if (infoCount > 0) severity = ProblemSeverity.Info;

    return {
      severity,
      errorCount,
      warningCount,
      infoCount,
      fileCount: errorCount + warningCount + infoCount > 0 ? 1 : 0,
    };
  }
}