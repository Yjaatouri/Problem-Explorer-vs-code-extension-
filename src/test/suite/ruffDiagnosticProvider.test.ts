import * as assert from 'assert';
import { Uri } from 'vscode';
import * as path from 'path';
import { ProblemStore } from '../../store/ProblemStore';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { ProblemSeverity, RuffConfig } from '../../core/types';
import { BADGE_LETTERS } from '../../core/constants';
import {
  RuffDiagnosticProvider,
  parseRuffJson,
  severityOf,
} from '../../providers/RuffDiagnosticProvider';

suite('RuffDiagnosticProvider severity mapping', () => {
  const wsPath = path.resolve('/workspace'); // drive-aware on Windows
  const folderUri = Uri.parse('file:///workspace');
  const cfg: RuffConfig = {
    enabled: true,
    autoScan: true,
    scanOnStartup: true,
    timeout: 120000,
    maxConcurrentScans: 2,
  };

  /** Canonical URI for a workspace-relative file (same construction as the provider). */
  function fileUri(rel: string): Uri {
    return Uri.file(path.resolve(wsPath, rel));
  }

  function makeEngine(store: ProblemStore): DecorationEngine {
    return new DecorationEngine(store, {
      getWorkspaceFolder: () => ({ uri: folderUri, name: 'workspace', index: 0 }),
    });
  }

  /** Run one ruff JSON blob through parse → provider.writeToStore; return the store + engine. */
  function runPipeline(stdout: string): { store: ProblemStore; engine: DecorationEngine } {
    const store = new ProblemStore();
    const provider = new RuffDiagnosticProvider(store, cfg);
    const parsed = parseRuffJson(stdout);
    const byUri = new Map<string, Array<{ uri: Uri; line: number | undefined; column: number | undefined; severity: number; message: string; code: string }>>();
    for (const d of parsed) {
      const uri = fileUri(d.file);
      const existing = byUri.get(uri.toString()) ?? [];
      existing.push({ uri, line: d.line, column: d.column, severity: d.severity, message: d.message, code: d.code });
      byUri.set(uri.toString(), existing);
    }
    (provider as any).writeToStore(byUri);
    return { store, engine: makeEngine(store) };
  }

  // ---------- severityOf ----------

  test('severityOf maps ruff "error" to ProblemSeverity.Error', () => {
    assert.strictEqual(severityOf('F401', 'error'), ProblemSeverity.Error);
  });

  test('severityOf maps ruff "warning" to ProblemSeverity.Warning', () => {
    assert.strictEqual(severityOf('W605', 'warning'), ProblemSeverity.Warning);
  });

  test('severityOf maps ruff "info" to ProblemSeverity.Info', () => {
    assert.strictEqual(severityOf('D100', 'info'), ProblemSeverity.Info);
  });

  test('severityOf falls back by rule-code prefix: F → Error', () => {
    assert.strictEqual(severityOf('F401'), ProblemSeverity.Error);
  });

  test('severityOf falls back by rule-code prefix: W/I/R/C/P/D/ANN/B0 → Warning', () => {
    for (const code of ['W605', 'I001', 'RUF001', 'C901', 'PLR0913', 'D103', 'ANN001', 'B002']) {
      assert.strictEqual(severityOf(code), ProblemSeverity.Warning, `code ${code}`);
    }
  });

  // ---------- parseRuffJson ----------

  test('parseRuffJson reads filename/location and derives severity from code', () => {
    const json = JSON.stringify([
      { filename: 'a.py', code: 'F401', message: 'unused import', location: { row: 3, column: 5 } },
    ]);
    const items = parseRuffJson(json);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].file, 'a.py');
    assert.strictEqual(items[0].line, 3);
    assert.strictEqual(items[0].column, 5);
    assert.strictEqual(items[0].severity, ProblemSeverity.Error);
  });

  test('parseRuffJson returns [] for invalid JSON', () => {
    assert.deepStrictEqual(parseRuffJson('not json{'), []);
  });

  // ---------- smoke: actual badge severity, not just presence ----------

  test('Ruff error produces an E badge, not just any badge', () => {
    const { engine } = runPipeline(
      JSON.stringify([{ file: 'a.py', code: 'F401', message: 'unused', line: 1, column: 1, severity: 'error' }]),
    );
    const deco = engine.provideFileDecoration(fileUri('a.py'), {} as any);
    assert.ok(deco, 'expected a decoration');
    assert.strictEqual(deco.badge, BADGE_LETTERS.error); // 'E'
  });

  test('Ruff warning produces a W badge', () => {
    const { engine } = runPipeline(
      JSON.stringify([{ file: 'b.py', code: 'W605', message: 'invalid escape', line: 2, column: 1, severity: 'warning' }]),
    );
    const deco = engine.provideFileDecoration(fileUri('b.py'), {} as any);
    assert.ok(deco, 'expected a decoration');
    assert.strictEqual(deco.badge, BADGE_LETTERS.warning); // 'W'
  });

  test('Ruff info produces an I badge', () => {
    const { engine } = runPipeline(
      JSON.stringify([{ file: 'c.py', code: 'D100', message: 'missing docstring', line: 1, column: 1, severity: 'info' }]),
    );
    const deco = engine.provideFileDecoration(fileUri('c.py'), {} as any);
    assert.ok(deco, 'expected a decoration');
    assert.strictEqual(deco.badge, BADGE_LETTERS.info); // 'I'
  });

  test('mixed severities escalate to the highest (E wins over W)', () => {
    const { engine } = runPipeline(
      JSON.stringify([
        { file: 'd.py', code: 'W605', message: 'warn', line: 1, column: 1, severity: 'warning' },
        { file: 'd.py', code: 'F401', message: 'err', line: 2, column: 1, severity: 'error' },
      ]),
    );
    const deco = engine.provideFileDecoration(fileUri('d.py'), {} as any);
    assert.ok(deco);
    assert.strictEqual(deco.badge, BADGE_LETTERS.error);
  });
});
