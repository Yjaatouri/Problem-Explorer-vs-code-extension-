import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { VSDiagnosticsProvider } from '../../providers/VSDiagnosticsProvider';
import { ProviderManager } from '../../services/ProviderManager';
import type { DiagnosticsManager } from '../../diagnostics/diagnosticsManager';
import type { FolderStatusManager } from '../../folder/folderStatusManager';
import type { ApiManager } from '../../api/problemExplorerApi';
import type { DecorationEngine } from '../../decoration/decorationEngine';
import type { StatusBarManager } from '../../statusBar/statusBarManager';
import type { TrendTracker } from '../../trend/trendTracker';
import type { ProblemCache } from '../../cache/cacheLayer';
import type { ProblemStore } from '../../store/ProblemStore';

function createMockDiagnosticsManager(): DiagnosticsManager {
  return {
    processChanges: () => [],
    fullScan: () => [],
    getEventDiagnosticsCounts: () => [],
  } as unknown as DiagnosticsManager;
}

function createMockFolderStatusManager(): FolderStatusManager {
  return {
    updateAncestors: () => [],
    rebuildAll: () => [],
    clearIndexPrefix: () => {},
  } as unknown as FolderStatusManager;
}

function createMockApiManager(): ApiManager {
  return {
    notifyChanged: () => {},
  } as unknown as ApiManager;
}

function createMockDecorationEngine(): DecorationEngine {
  return {
    fireDidChange: () => {},
    refresh: () => {},
  } as unknown as DecorationEngine;
}

function createMockStatusBarManager(): StatusBarManager {
  return {
    update: () => {},
  } as unknown as StatusBarManager;
}

function createMockTrendTracker(): TrendTracker {
  return {
    takeSnapshot: () => {},
  } as unknown as TrendTracker;
}

function createMockCache(): ProblemCache {
  return {
    get: () => undefined,
    computeTotals: () => ({ severity: 0, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0 }),
  } as unknown as ProblemCache;
}

function createMockProblemStore(): ProblemStore {
  return {
    set: () => {},
    delete: () => false,
  } as unknown as ProblemStore;
}

function createProvider(): VSDiagnosticsProvider {
  return new VSDiagnosticsProvider(
    createMockDiagnosticsManager(),
    createMockFolderStatusManager(),
    createMockApiManager(),
    createMockDecorationEngine(),
    createMockStatusBarManager(),
    createMockTrendTracker(),
    createMockCache(),
    createMockProblemStore(),
    () => {},
  );
}

suite('VSDiagnosticsProvider', () => {
  let onDiagSpy: sinon.SinonSpy | undefined;

  teardown(() => {
    onDiagSpy?.restore();
  });

  test('isRunning is false before start', () => {
    const provider = createProvider();
    assert.strictEqual(provider.isRunning, false);
    provider.dispose();
  });

  test('isDisposed is false before dispose', () => {
    const provider = createProvider();
    assert.strictEqual(provider.isDisposed, false);
    provider.dispose();
  });

  test('start sets isRunning to true', () => {
    const provider = createProvider();
    provider.start();
    assert.strictEqual(provider.isRunning, true);
    provider.dispose();
  });

  test('stop sets isRunning to false', () => {
    const provider = createProvider();
    provider.start();
    assert.strictEqual(provider.isRunning, true);
    provider.stop();
    assert.strictEqual(provider.isRunning, false);
    provider.dispose();
  });

  test('double start is safe', () => {
    const provider = createProvider();
    provider.start();
    provider.start();
    assert.strictEqual(provider.isRunning, true);
    provider.dispose();
  });

  test('double stop is safe', () => {
    const provider = createProvider();
    provider.start();
    provider.stop();
    provider.stop();
    assert.strictEqual(provider.isRunning, false);
    provider.dispose();
  });

  test('double dispose is safe', () => {
    const provider = createProvider();
    provider.dispose();
    provider.dispose();
    assert.strictEqual(provider.isDisposed, true);
  });

  test('operations throw after dispose', () => {
    const provider = createProvider();
    provider.dispose();
    assert.throws(() => provider.start(), /disposed/);
    assert.throws(() => provider.stop(), /disposed/);
    assert.throws(() => provider.refresh(), /disposed/);
  });

  test('register with ProviderManager', () => {
    const pm = new ProviderManager();
    const provider = createProvider();
    pm.register('vsDiagnostics', provider);
    assert.strictEqual(pm.size, 1);
    assert.strictEqual(pm.get('vsDiagnostics'), provider);
    pm.dispose();
  });

  test('ProviderManager startAll starts the provider', () => {
    const pm = new ProviderManager();
    const provider = createProvider();
    pm.register('vsDiagnostics', provider);
    pm.startAll();
    assert.strictEqual(provider.isRunning, true);
    pm.dispose();
  });

  test('ProviderManager dispose disposes the provider', () => {
    const pm = new ProviderManager();
    const provider = createProvider();
    pm.register('vsDiagnostics', provider);
    pm.dispose();
    assert.strictEqual(provider.isDisposed, true);
  });

  test('refresh does not throw', () => {
    const provider = createProvider();
    provider.start();
    provider.refresh();
    provider.dispose();
  });

  test('start subscribes to onDidChangeDiagnostics', () => {
    onDiagSpy = sinon.spy(vscode.languages, 'onDidChangeDiagnostics');
    const provider = createProvider();
    provider.start();
    assert.strictEqual(onDiagSpy.calledOnce, true);
    provider.dispose();
  });

  test('dispose sets isDisposed and clears isRunning', () => {
    const provider = createProvider();
    provider.start();
    assert.strictEqual(provider.isRunning, true);
    assert.strictEqual(provider.isDisposed, false);
    provider.dispose();
    assert.strictEqual(provider.isRunning, false);
    assert.strictEqual(provider.isDisposed, true);
  });

  test('stop does not set isDisposed', () => {
    const provider = createProvider();
    provider.start();
    provider.stop();
    assert.strictEqual(provider.isRunning, false);
    assert.strictEqual(provider.isDisposed, false);
    provider.dispose();
  });
});
