import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

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
const EXTENSION_ID = 'problem-explorer.problem-explorer';

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

  suiteSetup(async () => {
    // VS Code restores PATH from the registry in the ext host on Windows;
    // make the repo's tsc/eslint reachable before the engine is built.
    const binDir = path.resolve(__dirname, '../../../../../node_modules/.bin');
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is installed in the dev host`);
    handle = (await ext.activate()) as HostApiLike;
    assert.ok(handle, 'activate() returned the HostApi');

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(folderUri, 'a workspace folder is open');
    folder = folderUri;
    brokenUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'broken.ts'));
    cleanUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'clean.ts'));
    pyUri = vscode.Uri.file(path.join(folder.fsPath, 'src', 'app.py'));

    const initial = handle.api();
    assert.ok(initial, 'a live API exists after activation');
    api = initial;
  });

  suiteTeardown(() => {
    // Restore defaults so a second run starts from the same state.
    void vscode.workspace
      .getConfiguration('problemExplorer')
      .update('enabled', true, vscode.ConfigurationTarget.Workspace);
  });

  test('scan: broken file surfaces a tsc error AND an explorer badge', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    // Touch first: the analyzer coalesces identical requests away, so a raw
    // manual folder scan right after startup can be deduped/ignored.
    fs.writeFileSync(brokenUri.fsPath, "const value: number = 'not-a-number';\n", { mode: 0o666 });
    api.scanOnSave(brokenUri);
    await api.scan('manual' as never, [folder]);
    await untilHits(() => api.getTotals().errors >= 1, 'tsc error surfaced', 60_000, 200);

    // The real registered provider renders a letter badge for the broken file.
    const badge = handle.renderDecoration(brokenUri);
    assert.ok(badge, 'broken.ts gets a decoration through the registered provider');
    assert.ok(badge.badge === 'E', `expected letter badge "E", got ${JSON.stringify(badge.badge)}`);
    assert.ok(String(badge.tooltip).includes('1 error'), `tooltip mentions the error: ${badge.tooltip}`);

    const clean = handle.renderDecoration(cleanUri);
    assert.ok(clean === undefined, 'clean.ts gets no decoration');
  });

  test('realtime: host-set diagnostics land in the store and clear again', async function () {
    this.timeout(120_000);

    api = handle.api()!;
    // .py is NOT scanned by tsc here → realtime owns it → pushes are accepted
    // (broken.ts is scanner-owned and gates editor pushes by design).
    const baselineErrors = api.getProblems(pyUri).errorCount;
    const range = new vscode.Range(0, 0, 0, 12);

    // A real DiagnosticCollection fires the same onDidChangeDiagnostics events
    // real extensions go through (and is stable API on every host).
    const collection = vscode.languages.createDiagnosticCollection('pe-smoke');
    try {
      collection.set(pyUri, [
        new vscode.Diagnostic(range, 'synthetic realtime error', vscode.DiagnosticSeverity.Error),
      ]);
      await untilHits(
        () => api.getProblems(pyUri).errorCount > baselineErrors,
        'editor diagnostics pushed into the store',
        30_000,
      );

      collection.delete(pyUri);
      await untilHits(
        () => api.getProblems(pyUri).errorCount === baselineErrors,
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
    await untilHits(() => api.getTotals().errors >= 1, 'new engine scans', 60_000);
    await untilHits(() => handle.renderDecoration(brokenUri) !== undefined, 'badge returns', 30_000);

    assert.ok(oldEvents === 0, 'old engine emitted no totals events after dispose');
    const oldTotals = oldApi.getTotals();
    assert.ok(
      oldTotals.errors + oldTotals.warnings + oldTotals.info === 0,
      `old engine totals stay zero (got ${JSON.stringify(oldTotals)})`,
    );
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