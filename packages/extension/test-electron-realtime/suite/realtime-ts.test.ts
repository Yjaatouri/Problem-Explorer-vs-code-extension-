import * as assert from 'assert';
import * as path from 'path';

import * as vscode from 'vscode';

import type { DiagnosticsAPI } from '@pe/api';

/**
 * Realtime-only host smoke. This suite runs in a host whose PATH was NOT
 * extended (runTestRealtime.ts), so tsc/eslint/ruff are MissingDependency
 * and the realtime provider is the only owner for .ts files — the
 * environment the extension actually runs in on Windows (registry PATH).
 *
 * The scenario under test is the one the extension historically missed:
 * a broken .ts file whose VS Code diagnostics already exist while the file
 * was never opened — and whose badge must survive an engine rebuild purely
 * through the syncAll() backfill (no new diagnostics event, no scan).
 */
const EXTENSION_ID = 'Yjaatouri.problem-explorer';

/** Extension-host-level error log: real uncaught/rejected async failures. */
const hostErrors: string[] = [];
const hostRejections: string[] = [];

interface HostApiLike {
  api(): DiagnosticsAPI | undefined;
  renderDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
  statusText(): string | undefined;
}

suite('realtime .ts badge (no scanner on PATH)', () => {
  let handle: HostApiLike;
  let api: DiagnosticsAPI;
  let folder: vscode.Uri;
  let brokenUri: vscode.Uri;

  suiteSetup(async () => {
    // Deliberately NO PATH manipulation: tsc/eslint must be missing so the
    // editor owns .ts files (§9.2 fallback).
    process.on('uncaughtException', (err) => {
      hostErrors.push(String(err));
    });
    process.on('unhandledRejection', (reason) => {
      hostRejections.push(String(reason));
    });

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is installed in the dev host`);
    handle = (await ext.activate()) as HostApiLike;
    assert.ok(handle, 'activate() returned the HostApi');

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(folderUri, 'a workspace folder is open');
    folder = folderUri;
    brokenUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'broken.ts'));

    const initial = handle.api();
    assert.ok(initial, 'a live API exists after activation');
    api = initial;
  });

  suiteTeardown(() => {
    // Restore defaults so a second run starts from the same state.
    const config = vscode.workspace.getConfiguration('problemExplorer');
    void config.update('eslint.enabled', true, vscode.ConfigurationTarget.Workspace);
    // The whole suite must not have crashed anything in the host.
    assert.strictEqual(
      hostErrors.length,
      0,
      `extension host uncaught exceptions: ${hostErrors.join('; ')}`,
    );
    assert.strictEqual(
      hostRejections.length,
      0,
      `extension host unhandled rejections: ${hostRejections.join('; ')}`,
    );
  });

  test('closed broken .ts: editor diagnostics surface a badge and survive a rebuild via backfill', async function () {
    this.timeout(120_000);

    // Precondition: the file is NOT open, has no problems, and no scanner
    // owns it (tsc/eslint are missing on this host's PATH).
    assert.ok(
      vscode.window.visibleTextEditors.every(
        (editor) => editor.document.uri.toString() !== brokenUri.toString(),
      ),
      'broken.ts is not open before the test',
    );
    assert.strictEqual(api.getProblems(brokenUri).errorCount, 0, 'no problems before the push');
    assert.strictEqual(api.rejectedWriteCount, 0, 'no gated writes before the push');

    // The editor already knows about the error (e.g. published before the
    // engine existed) — a plain DiagnosticCollection fires the same
    // onDidChangeDiagnostics events real language servers go through.
    const collection = vscode.languages.createDiagnosticCollection('pe-realtime-ts');
    try {
      collection.set(brokenUri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 33),
          'type error: string is not assignable to number',
          vscode.DiagnosticSeverity.Error,
        ),
      ]);

      await untilHits(
        () => api.getProblems(brokenUri).errorCount >= 1,
        'editor diagnostics pushed into the store',
        30_000,
      );
      await untilHits(
        () => handle.renderDecoration(brokenUri) !== undefined,
        'badge appears through the registered provider',
        30_000,
      );
      // Layer evidence: the editor produced the diagnostics and owns the URI.
      assert.ok(
        !handle.api()!.getOwners(brokenUri).includes('tsc'),
        'no scanner claimed ownership without a result',
      );
      assert.strictEqual(api.rejectedWriteCount, 0, 'editor pushes were not gated');

      // Engine rebuild (e.g. a config change) starts a FRESH store. No new
      // diagnostics event fires — only the syncAll() backfill can restore
      // the badge.
      const oldApi = api;
      await configUpdate('eslint.enabled', false);
      await untilHits(() => {
        const current = handle.api();
        return current !== undefined && current !== oldApi;
      }, 'engine rebuilt with a fresh instance', 30_000);
      api = handle.api()!;

      await untilHits(
        () => api.getProblems(brokenUri).errorCount >= 1,
        'backfill restored the diagnostics after the rebuild',
        30_000,
      );
      await untilHits(
        () => handle.renderDecoration(brokenUri) !== undefined,
        'badge survives the rebuild without any new diagnostics event',
        30_000,
      );

      // The file was still never opened — the badge never depended on that.
      assert.ok(
        vscode.window.visibleTextEditors.every(
          (editor) => editor.document.uri.toString() !== brokenUri.toString(),
        ),
        'broken.ts was never opened during the test',
      );
    } finally {
      collection.dispose();
    }
  });

  function configUpdate(key: string, value: unknown): Thenable<void> {
    return vscode.workspace
      .getConfiguration('problemExplorer')
      .update(key, value, vscode.ConfigurationTarget.Workspace);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function untilHits(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
  pollMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(pollMs);
  }
  assert.ok(predicate(), `timeout waiting for: ${what}`);
}