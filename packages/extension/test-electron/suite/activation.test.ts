import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';
import { spawnSync } from 'child_process';

import type { DiagnosticsAPI } from '@pe/api';

/**
 * Host smoke: exercises the REAL registered VS Code surfaces inside the
 * extension host (extension.ts pipeworks username path):
 *
 *   1. scan     — broken file → tsc → ProblemStore → DecorationEngine
 *                 → VscodeDecorationAdapter → FileDecoration (through the
 *                 registered provider, the same instance the explorer uses)
 *   2. realtime — vscode.languages.setDiagnostics → bridge → store updates,
 *                 and clearing them drops the totals again
 *   3. status   — scanning state text while a scan runs, totals text after
 *   4. lifecycle— enabled=false → old engine disposed, badge gone;
 *                 enabled=true  → NEW engine, scan, badge returns
 *
 * The fixture workspace is scaffolded by runTest.ts (broken.ts under strict).
 */
const EXTENSION_ID = 'Yjaatouri.problem-explorer';

/** Extension-host-level error log for Step 12: real uncaught/rejected async failures. */
const hostErrors: string[] = [];
const hostRejections: string[] = [];

interface HostApiLike {
  api(): DiagnosticsAPI | undefined;
  renderDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
  statusText(): string | undefined;
}

suite('extension host smoke', () => {
  let handle: HostApiLike;
  let api: DiagnosticsAPI;
  let folder: vscode.Uri;
  let brokenUri: vscode.Uri;
  let cleanUri: vscode.Uri;
  let pyUri: vscode.Uri;
  let notesUri: vscode.Uri;
  let lintmeUri: vscode.Uri;

  suiteSetup(async () => {
    // VS Code restores PATH from the registry in the ext host on Windows;
    // make the repo's tsc/eslint reachable before the engine is built.
    const binDir = path.resolve(__dirname, '../../../../../node_modules/.bin');
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

    // Anything the extension throws without handling is a provider/engine crash.
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
    cleanUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'clean.ts'));
    // ruff-owned fixture: undefined name → F821 error.
    pyUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'broken.py'));
    // .txt is not scanner-owned: realtime diagnostics own it in the smoke.
    notesUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'notes.txt'));
    // eslint-owned fixture: deterministic no-unused-vars error (tsc owns no .js).
    lintmeUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'lintme.js'));

    const initial = handle.api();
    assert.ok(initial, 'a live API exists after activation');
    api = initial;
  });

  suiteTeardown(() => {
    // Restore defaults so a second run starts from the same state.
    const config = vscode.workspace.getConfiguration('problemExplorer');
    void config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
    void config.update('typescript.enabled', true, vscode.ConfigurationTarget.Workspace);
    void config.update('eslint.enabled', true, vscode.ConfigurationTarget.Workspace);
    void config.update('ruff.enabled', true, vscode.ConfigurationTarget.Workspace);
    // The whole suite must not have crashed anything in the host.
    assert.strictEqual(hostErrors.length, 0, `extension host uncaught exceptions: ${hostErrors.join('; ')}`);
    assert.strictEqual(
      hostRejections.length,
      0,
      `extension host unhandled rejections: ${hostRejections.join('; ')}`,
    );
  });

  test('activation: extension activates cleanly and registers its commands', async function () {
    this.timeout(60_000);

    assert.ok(handle.api(), 'engine api live after activation');
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['problemExplorer.refresh', 'problemExplorer.scanWorkspace', 'problemExplorer.toggle']) {
      assert.ok(commands.includes(id), `command ${id} is registered`);
    }
    assert.strictEqual(hostErrors.length, 0, 'no host errors during activation');
    assert.strictEqual(hostRejections.length, 0, 'no host rejections during activation');
  });

  test('scan: broken file surfaces a tsc error AND an explorer badge', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    // Touch first: the analyzer coalesces identical requests away, so a raw
    // manual folder scan right after startup can be deduped/ignored.
    fs.writeFileSync(brokenUri.fsPath, "const value: number = 'not-a-number';\n", { mode: 0o666 });
    api.scanOnSave(brokenUri);
    await api.scan('manual' as never, [folder]);
    // Per-file wait: folder totals can already include ruff's broken.py error,
    // which must not satisfy the tsc-specific assertion below.
    await untilHits(
      () => api.getProblems(brokenUri).errorCount >= 1,
      'tsc error surfaced for broken.ts',
      60_000,
      200,
    );

    // The real registered provider renders a letter badge for the broken file.
    const badge = handle.renderDecoration(brokenUri);
    assert.ok(badge, 'broken.ts gets a decoration through the registered provider');
    assert.ok(badge.badge === 'E', `expected letter badge "E", got ${JSON.stringify(badge.badge)}`);
    assert.ok(String(badge.tooltip).includes('1 error'), `tooltip mentions the error: ${badge.tooltip}`);

    const clean = handle.renderDecoration(cleanUri);
    assert.ok(clean === undefined, 'clean.ts gets no decoration');
  });

  test('ruff: broken python file surfaces an F821 error AND an explorer badge', async function () {
    if (!ruffAvailable()) {
      this.skip();
      return;
    }
    this.timeout(120_000);

    api = handle.api()!;
    // Touch first: the analyzer coalesces identical requests away, so a raw
    // manual folder scan right after startup can be deduped/ignored.
    fs.writeFileSync(pyUri.fsPath, 'print(undefined_variable)\n');
    api.scanOnSave(pyUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(
      () => api.getProblems(pyUri).errorCount >= 1,
      'ruff F821 surfaced for broken.py',
      60_000,
      200,
    );

    // The real registered provider renders a letter badge for the broken
    // python file — without anyone opening it.
    const badge = handle.renderDecoration(pyUri);
    assert.ok(badge, 'broken.py gets a decoration through the registered provider');
    assert.ok(badge.badge === 'E', `expected letter badge "E", got ${JSON.stringify(badge.badge)}`);
    assert.ok(
      String(badge.tooltip).includes('1 error'),
      `tooltip mentions the error: ${badge.tooltip}`,
    );

    // The scanner claims python ownership now (the provider-architecture proof).
    assert.ok(handle.api()!.getOwners(pyUri).includes('ruff'), 'ruff owns broken.py');
  });

  test('realtime: host-set diagnostics land in the store and clear again', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    // .txt is NOT scanner-owned → realtime owns it → pushes are accepted
    // (broken.ts/broken.py are scanner-owned and gate editor pushes by design).
    const baselineErrors = api.getProblems(notesUri).errorCount;
    const range = new vscode.Range(0, 0, 0, 12);

    // A real DiagnosticCollection fires the same onDidChangeDiagnostics events
    // real extensions go through (and is stable API on every host).
    const collection = vscode.languages.createDiagnosticCollection('pe-smoke');
    try {
      collection.set(notesUri, [
        new vscode.Diagnostic(range, 'synthetic realtime error', vscode.DiagnosticSeverity.Error),
      ]);
      await untilHits(
        () => api.getProblems(notesUri).errorCount > baselineErrors,
        'editor diagnostics pushed into the store',
        30_000,
      );

      collection.delete(notesUri);
      await untilHits(
        () => api.getProblems(notesUri).errorCount === baselineErrors,
        'cleared editor diagnostics drop out of the store',
        30_000,
      );
    } finally {
      collection.dispose();
    }
  });

  test('status bar: scanning state flips, totals text is correct', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    // Touch the file so the analyzer doesn't coalesce the scan away; then force
    // a per-file scan so the scanning phase lasts long enough to observe.
    fs.writeFileSync(brokenUri.fsPath, "const value: number = 'not-a-number';\n", {
      mode: 0o666,
    });
    api.scanOnSave(brokenUri);
    await api.scan('manual' as never, [brokenUri]);

    await untilHits(
      () => (handle.statusText() ?? '').includes('Scanning'),
      'status bar enters scanning state',
      30_000,
      100,
    );
    await untilHits(
      () => handle.statusText()?.includes('$(error)') ?? false,
      'status bar shows error totals',
      60_000,
      100,
    );
  });

  test('lifecycle: disabled config disposes the engine, re-enabling rebuilds it', async function () {
    this.timeout(120_000);

    const oldApi = handle.api();
    assert.ok(oldApi, 'engine exists before the flip');
    let oldEvents = 0;
    oldApi.onTotalsChanged(() => {
      oldEvents += 1;
    });

    // OFF: engine is disposed and the badge disappears.
    await configUpdate('enabled', false);
    await untilHits(() => handle.api() === undefined, 'old engine removed', 30_000);
    assert.deepStrictEqual(
      { e: oldApi.getTotals().errors, w: oldApi.getTotals().warnings, i: oldApi.getTotals().info },
      { e: 0, w: 0, i: 0 },
      'old engine store is emptied at dispose',
    );
    assert.ok(handle.renderDecoration(brokenUri) === undefined, 'badge gone while disabled');

    // The disposed instance must neither produce events nor run scans.
    await oldApi.scan('manual' as never, [folder]);
    await sleep(1500);
    const totalsAfterZombieScan = oldApi.getTotals();
    assert.ok(
      totalsAfterZombieScan.errors + totalsAfterZombieScan.warnings + totalsAfterZombieScan.info === 0,
      `disposed engine stays inert (got ${JSON.stringify(totalsAfterZombieScan)})`,
    );

    // ON: a NEW instance replaces the old one and works immediately.
    await configUpdate('enabled', true);
    await untilHits(() => {
      const current = handle.api();
      return current !== undefined && current !== oldApi;
    }, 'engine rebuilt with a fresh instance', 30_000);
    api = handle.api()!;

    await api.scan('manual' as never, [folder]);
    // Per-file wait, same reason as the scan test: ruff's broken.py error can
    // satisfy totals before tsc reports broken.ts.
    await untilHits(() => api.getProblems(brokenUri).errorCount >= 1, 'new engine scans', 60_000);
    await untilHits(() => handle.renderDecoration(brokenUri) !== undefined, 'badge returns', 30_000);

    assert.ok(oldEvents === 0, 'old engine emitted no totals events after dispose');
    const oldTotals = oldApi.getTotals();
    assert.ok(
      oldTotals.errors + oldTotals.warnings + oldTotals.info === 0,
      `old engine totals stay zero (got ${JSON.stringify(oldTotals)})`,
    );
  });

  test('eslint: js violation reaches the store AND the explorer, fixing clears both', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    fs.writeFileSync(lintmeUri.fsPath, 'const unused = 1;\n', { mode: 0o666 });
    api.scanOnSave(lintmeUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(() => api.getProblems(lintmeUri).errorCount >= 1, 'eslint violation surfaced', 60_000, 200);

    // Explorer badge without opening the file.
    const badge = handle.renderDecoration(lintmeUri);
    assert.ok(badge, 'lintme.js gets a decoration through the registered provider');
    assert.ok(badge.badge === 'E', `expected letter badge "E", got ${JSON.stringify(badge.badge)}`);
    assert.ok(String(badge.tooltip).includes('1 error'), `tooltip mentions the error: ${badge.tooltip}`);
    assert.ok(handle.api()!.getOwners(lintmeUri).includes('eslint'), 'eslint owns lintme.js');

    // ESLint does not interfere with tsc ownership of .ts files.
    const tsOwners = handle.api()!.getOwners(brokenUri);
    assert.ok(tsOwners.includes('tsc'), 'tsc still owns broken.ts');
    assert.ok(!tsOwners.includes('eslint'), 'eslint does not claim .ts ownership while tsc is healthy');

    // Fixing the file clears the store slot and the decoration after the scan.
    fs.writeFileSync(lintmeUri.fsPath, 'export const used = 1;\n');
    api.scanOnSave(lintmeUri);
    await untilHits(() => api.getProblems(lintmeUri).errorCount === 0, 'eslint violation cleared after fix', 60_000);
    assert.ok(handle.renderDecoration(lintmeUri) === undefined, 'decoration gone after fix');
  });

  test('config: disabling ruff degrades cleanly, re-enabling restores it', async function () {
    this.timeout(120_000);

    const oldApi = handle.api()!;
    await configUpdate('ruff.enabled', false);
    await untilHits(() => {
      const current = handle.api();
      return current !== undefined && current !== oldApi;
    }, 'engine rebuilt without ruff', 30_000);
    api = handle.api()!;

    // Ruff gone → .py falls back to the editor → no diagnostics, no badge, no crash.
    assert.strictEqual(api.getProblems(pyUri).errorCount, 0, 'ruff F821 gone while disabled');
    assert.ok(handle.renderDecoration(pyUri) === undefined, 'python badge gone while disabled');
    await untilHits(() => api.getProblems(brokenUri).errorCount >= 1, 'tsc still works while ruff is disabled', 60_000);

    await configUpdate('ruff.enabled', true);
    await untilHits(() => {
      const current = handle.api();
      return current !== undefined && current !== api;
    }, 'engine rebuilt with ruff', 30_000);
    api = handle.api()!;

    fs.writeFileSync(pyUri.fsPath, 'print(undefined_variable)\n');
    api.scanOnSave(pyUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(() => api.getProblems(pyUri).errorCount >= 1, 'ruff F821 returns after re-enable', 60_000, 200);
  });

  test('config: typescript.enabled=false clears stale tsc state, true restores scanning', async function () {
    this.timeout(120_000);

    const oldApi = handle.api()!;
    await configUpdate('typescript.enabled', false);
    await untilHits(() => {
      const current = handle.api();
      return current !== undefined && current !== oldApi;
    }, 'engine rebuilt without tsc', 30_000);
    api = handle.api()!;

    await untilHits(() => api.getProblems(brokenUri).errorCount === 0, 'old tsc diagnostics cleared', 30_000);
    assert.ok(handle.renderDecoration(brokenUri) === undefined, 'tsc badge gone while disabled');

    // ESLint stays healthy on the rebuilt engine — no duplicate providers/listeners.
    fs.writeFileSync(lintmeUri.fsPath, 'const unused = 1;\n');
    api.scanOnSave(lintmeUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(() => api.getProblems(lintmeUri).errorCount >= 1, 'eslint still scans without tsc', 60_000, 200);
    fs.writeFileSync(lintmeUri.fsPath, 'export const used = 1;\n');
    api.scanOnSave(lintmeUri);
    await untilHits(() => api.getProblems(lintmeUri).errorCount === 0, 'eslint cleared again', 60_000);

    await configUpdate('typescript.enabled', true);
    await untilHits(() => {
      const current = handle.api();
      return current !== undefined && current !== api;
    }, 'engine rebuilt with tsc', 30_000);
    api = handle.api()!;

    fs.writeFileSync(brokenUri.fsPath, "const value: number = 'not-a-number';\n", { mode: 0o666 });
    api.scanOnSave(brokenUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(() => api.getProblems(brokenUri).errorCount >= 1, 'tsc diagnostics return', 60_000, 200);
    await untilHits(() => handle.renderDecoration(brokenUri) !== undefined, 'tsc badge returns', 30_000);
  });

  test('save burst: rapid saves stay coalesced, no duplicate diagnostics accumulate', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    fs.writeFileSync(brokenUri.fsPath, "const value: number = 'not-a-number';\n", { mode: 0o666 });
    api.scanOnSave(brokenUri);
    await api.scan('manual' as never, [brokenUri]);
    await untilHits(() => api.getProblems(brokenUri).errorCount >= 1, 'baseline tsc error', 60_000);

    // Rapid save burst — distinct contents so every save is a real change.
    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(brokenUri.fsPath, `const value: number = 'not-a-number';\n// burst ${i}\n`, {
        mode: 0o666,
      });
      api.scanOnSave(brokenUri);
      await sleep(30);
    }
    await sleep(2500); // let the debounced pipeline settle

    assert.strictEqual(api.getProblems(brokenUri).errorCount, 1, `exactly one tsc error after the burst`);
    assert.ok(handle.renderDecoration(brokenUri)?.badge === 'E', 'badge accurate after burst');
  });

  test('manual scan command: runs a workspace scan, surfaces problems, returns to idle', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    fs.writeFileSync(pyUri.fsPath, 'print(undefined_variable)\n');
    api.scanOnSave(pyUri);
    await vscode.commands.executeCommand('problemExplorer.scanWorkspace');
    await untilHits(() => api.getProblems(pyUri).errorCount >= 1, 'workspace scan surfaces ruff F821', 60_000, 200);
    await untilHits(
      () => !(handle.statusText() ?? '').includes('Scanning'),
      'status bar returns to idle',
      60_000,
      100,
    );
    assert.strictEqual(api.getProblems(pyUri).errorCount, 1, 'no duplicate ruff diagnostics after the command');
  });

  test('clean state: fixing every file empties the store, badges and totals', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    fs.writeFileSync(brokenUri.fsPath, 'export const ok: number = 42;\n', { mode: 0o666 });
    fs.writeFileSync(pyUri.fsPath, 'print("hello")\n');
    api.scanOnSave(brokenUri);
    api.scanOnSave(pyUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(
      () =>
        api.getProblems(brokenUri).errorCount +
          api.getProblems(pyUri).errorCount +
          api.getProblems(lintmeUri).errorCount +
          api.getProblems(notesUri).errorCount ===
        0,
      'all store slots empty',
      60_000,
    );

    const totals = api.getTotals();
    assert.ok(
      totals.errors + totals.warnings + totals.info === 0,
      `totals are zero, got ${JSON.stringify(totals)}`,
    );
    assert.ok(handle.renderDecoration(brokenUri) === undefined, 'no tsc badge');
    assert.ok(handle.renderDecoration(pyUri) === undefined, 'no ruff badge');
    assert.ok(handle.renderDecoration(lintmeUri) === undefined, 'no eslint badge');
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

/** Follows the repo's e2e-ruff convention: skip ruff assertions when the binary is missing. */
function ruffAvailable(): boolean {
  try {
    return spawnSync('ruff', ['--version'], { windowsHide: true }).status === 0;
  } catch {
    return false;
  }
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