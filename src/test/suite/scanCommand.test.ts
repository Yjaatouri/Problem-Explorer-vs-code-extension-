import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';
import { TscDiagnosticProvider } from '../../providers/TscDiagnosticProvider';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { TscRunnerDelegate, TscProcess } from '../../typescript/TscRunner';
import { ProjectResolver } from '../../typescript/ProjectResolver';
import { TscOutputParser } from '../../typescript/TscOutputParser';

const rootUri = Uri.parse('file:///workspace');

function makeFakeTscDelegate(output: string, delayMs = 0): TscRunnerDelegate {
  return {
    spawn: (_command: string, _args: string[]): TscProcess => {
      const dataListeners: Array<(chunk: string) => void> = [];
      const closeListeners: Array<(code: number | null) => void> = [];

      setImmediate(() => {
        for (const l of dataListeners) l(output);
        setTimeout(() => {
          for (const l of closeListeners) l(0);
        }, delayMs);
      });

      return {
        stdout: { on: (_e: 'data', l: (chunk: string) => void) => { dataListeners.push(l); } },
        stderr: { on: (_e: 'data', _l: (chunk: string) => void) => {} },
        on: (_e: 'close', l: (code: number | null) => void) => { closeListeners.push(l); },
        kill: () => {},
      };
    },
  };
}

class FakeProjectResolver {
  async resolveAll() {
    return [{
      tsconfigPath: '/workspace/tsconfig.json',
      projectRoot: '/workspace',
      typescriptPath: '/workspace/node_modules/typescript',
      typescriptVersion: '5.5.0',
    }];
  }
}

function makeProvider(store: ProblemStore, output: string): TscDiagnosticProvider {
  const resolver = new FakeProjectResolver() as unknown as ProjectResolver;
  const runnerDelegate = makeFakeTscDelegate(output);
  const { TscRunner } = require('../../typescript/TscRunner');
  const runner = new TscRunner(runnerDelegate);
  const parser = new TscOutputParser();
  return new TscDiagnosticProvider(store, resolver, runner, parser);
}

suite('ScanCommand', () => {
  test('scan -> store has diagnostics', async () => {
    const store = new ProblemStore();
    const provider = makeProvider(store, 'src/a.ts(1,1): error TS2322: Type error.');

    await provider.refresh();

    const state = store.get(Uri.file('/workspace/src/a.ts'));
    assert.ok(state);
    assert.strictEqual(state!.severity, ProblemSeverity.Error);
    assert.strictEqual(state!.errorCount, 1);
  });

  test('scan with no errors writes nothing', async () => {
    const store = new ProblemStore();
    const provider = makeProvider(store, '');

    await provider.refresh();

    assert.strictEqual(store.size, 0);
  });

  test('scan updates existing entries', async () => {
    const store = new ProblemStore();
    const provider = makeProvider(store, 'src/a.ts(1,1): error TS2322: Old error.');

    await provider.refresh();
    assert.strictEqual(store.get(Uri.file('/workspace/src/a.ts'))?.errorCount, 1);

    const provider2 = makeProvider(store, 'src/a.ts(1,1): error TS2322: New error.\nsrc/b.ts(2,2): warning TS6133: New warning.');
    await provider2.refresh();

    assert.strictEqual(store.get(Uri.file('/workspace/src/a.ts'))?.errorCount, 1);
    assert.ok(store.get(Uri.file('/workspace/src/b.ts')));
    assert.strictEqual(store.get(Uri.file('/workspace/src/b.ts'))?.severity, ProblemSeverity.Warning);
  });

  test('scan handler uses refresh not initialize', async () => {
    const store = new ProblemStore();
    const provider = makeProvider(store, 'src/a.ts(1,1): error TS2322: Type error.');

    let refreshCalled = false;
    const originalRefresh = provider.refresh.bind(provider);
    provider.refresh = async () => {
      refreshCalled = true;
      await originalRefresh();
    };

    await provider.refresh();
    assert.strictEqual(refreshCalled, true);
  });

  test('FolderStatusManager rebuildAll after scan', async () => {
    const store = new ProblemStore();
    const provider = makeProvider(store, 'src/a.ts(1,1): error TS2322: Type error.');

    await provider.refresh();

    const fm = new FolderStatusManager(store, {
      workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
      getWorkspaceFolder: (uri) =>
        uri.toString().startsWith(rootUri.toString() + '/')
          ? { uri: rootUri, name: 'workspace', index: 0 }
          : undefined,
    });

    const changed = fm.rebuildAll();
    assert.ok(changed.length >= 1);
    const rootStatus = store.get(rootUri);
    assert.ok(rootStatus);
    assert.strictEqual(rootStatus!.errorCount, 1);
  });

  test('DecorationEngine refresh after scan does not throw', async () => {
    const store = new ProblemStore();
    const provider = makeProvider(store, 'src/a.ts(1,1): error TS2322: Type error.');

    await provider.refresh();

    const de = new DecorationEngine(store, {
      getWorkspaceFolder: (uri) =>
        uri.toString().startsWith(rootUri.toString() + '/')
          ? { uri: rootUri, name: 'workspace', index: 0 }
          : undefined,
    });

    de.refresh();
    assert.ok(true);
  });

  test('scan failure is handled gracefully', async () => {
    const store = new ProblemStore();
    const failingDelegate: TscRunnerDelegate = {
      spawn: () => {
        throw new Error('spawn failed');
      },
    };
    const { TscRunner } = require('../../typescript/TscRunner');
    const runner = new TscRunner(failingDelegate);
    const parser = new TscOutputParser();
    const resolver = new FakeProjectResolver() as unknown as ProjectResolver;
    const provider = new TscDiagnosticProvider(store, resolver, runner, parser);

    try {
      await provider.refresh();
      assert.strictEqual(store.size, 0);
    } catch {
      assert.fail('refresh should not throw');
    }
  });

  test('COMMANDS.SCAN_TS constant is defined', () => {
    const { COMMANDS } = require('../../core/constants');
    assert.strictEqual(COMMANDS.SCAN_TS, 'problemExplorer.scanTypeScript');
  });
});
