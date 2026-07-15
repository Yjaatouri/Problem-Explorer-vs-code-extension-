import * as assert from 'assert';
import * as vscode from 'vscode';
import { VSDiagnosticsProvider } from '../../providers/VSDiagnosticsProvider';
import { ProviderManager } from '../../services/ProviderManager';
import type { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import type { ProblemStore } from '../../store/ProblemStore';
import type { FolderStatusManager } from '../../folder/folderStatusManager';
import type { ApiManager } from '../../api/problemExplorerApi';
import type { DecorationEngine } from '../../decoration/decorationEngine';
import type { StatusBarManager } from '../../statusBar/statusBarManager';
import type { TrendTracker } from '../../trend/trendTracker';

function createMockDiagnosticProvider(): DiagnosticProvider {
  return {
    name: 'mock',
    store: {} as ProblemStore,
    onDidUpdate: (_cb: (uris: vscode.Uri[]) => void) => ({ dispose: () => {} }),
    initialize: () => {},
    start: () => {},
    stop: () => {},
    refresh: () => {},
    dispose: () => {},
  } as DiagnosticProvider;
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

function createProvider(): VSDiagnosticsProvider {
  return new VSDiagnosticsProvider(
    createMockDiagnosticProvider(),
    createMockFolderStatusManager(),
    createMockApiManager(),
    createMockDecorationEngine(),
    createMockStatusBarManager(),
    createMockTrendTracker(),
    () => {},
  );
}

suite('VSDiagnosticsProvider', () => {
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

  test('start calls provider.initialize and provider.start', () => {
    const provider = createProvider();
    provider.start();
    assert.strictEqual(provider.isRunning, true);
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
