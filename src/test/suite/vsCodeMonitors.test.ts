import * as assert from 'assert';
import { Uri, CancellationTokenSource, EventEmitter } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { ScanProgress } from '../../core/types';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { ProblemSeverity, ProblemState } from '../../core/types';
import { TelemetryBus, getTelemetryBus, resetTelemetryBus } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { BusTelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetryConfigManager } from '../../telemetry/TelemetryConfig';
import { createAutoScannerMonitor } from '../../telemetry/monitors/AutoScannerMonitor';
import { createDiagnosticsMonitor } from '../../telemetry/monitors/DiagnosticsMonitor';
import { createDecorationMonitor } from '../../telemetry/monitors/DecorationMonitor';
import { createFolderMonitor } from '../../telemetry/monitors/FolderMonitor';

function makeState(overrides?: Partial<ProblemState>): ProblemState {
  return {
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
    ...overrides,
  };
}

function makeConfigManager(): TelemetryConfigManager {
  return new TelemetryConfigManager({
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
    }),
  });
}

suite('VS Code-dependent Telemetry Monitors', () => {
  let bus: TelemetryBus;
  let collected: TelemetryEvent[];

  setup(() => {
    resetTelemetryBus();
    bus = getTelemetryBus();
    bus.setEnabled(true);
    collected = [];
  });

  teardown(() => {
    resetTelemetryBus();
  });

  /* ------------------------------------------------------------------ */
  /*  AutoScannerMonitor                                                 */
  /* ------------------------------------------------------------------ */

  suite('AutoScannerMonitor', () => {
    test('publishes provider.scan events from scan progress', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createAutoScannerMonitor(manager, reporter);

      // Register a provider with onDidProgressScan
      const progressEmitter = new EventEmitter<ScanProgress>();
      const provider: DiagnosticProvider = {
        name: 'testProvider',
        store: new ProblemStore(),
        scanning: false,
        autoScan: false,
        enabled: true,
        capabilities: { extensions: [] },
        onDidUpdate: () => ({ dispose: () => {} }),
        onDidProgressScan: progressEmitter.event,
        initialize: () => {},
        start: () => {},
        stop: () => {},
        refresh: () => {},
        dispose: () => {},
      };
      manager.register('testProvider', provider, { priority: 5 });

      // Fire scan progress events through the provider
      progressEmitter.fire({ providerName: 'testProvider', phase: 'scanning' });
      progressEmitter.fire({ providerName: 'testProvider', phase: 'completed' });
      progressEmitter.fire({ providerName: 'testProvider', phase: 'error', message: 'scan failed' });
      progressEmitter.fire({ providerName: 'testProvider', phase: 'cancelled' });

      const scanEvents = collected.filter((e) => e.type === 'provider.scan');
      assert.ok(scanEvents.length >= 2, 'Expected provider.scan events from scan progress');
    });

    test('publishes autoscan.providerExecution on resolving and completed', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createAutoScannerMonitor(manager, reporter);

      const progressEmitter = new EventEmitter<ScanProgress>();
      const provider: DiagnosticProvider = {
        name: 'tsc',
        store: new ProblemStore(),
        scanning: false,
        autoScan: false,
        enabled: true,
        capabilities: { extensions: ['.ts'] },
        onDidUpdate: () => ({ dispose: () => {} }),
        onDidProgressScan: progressEmitter.event,
        initialize: () => {},
        start: () => {},
        stop: () => {},
        refresh: () => {},
        dispose: () => {},
      };
      manager.register('tsc', provider, { priority: 10 });

      progressEmitter.fire({ providerName: 'tsc', phase: 'resolving' });
      progressEmitter.fire({ providerName: 'tsc', phase: 'completed' });

      const execEvents = collected.filter((e) => e.type === 'autoscan.providerExecution');
      assert.ok(execEvents.length >= 2, 'Expected autoscan.providerExecution for resolving + completed');
      assert.strictEqual((execEvents[0] as any).provider, 'tsc');
      assert.strictEqual((execEvents[0] as any).scanPhase, 'resolving');
    });

    test('publishes autoscan.cancel on cancelled scan', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createAutoScannerMonitor(manager, reporter);

      const progressEmitter = new EventEmitter<ScanProgress>();
      const provider: DiagnosticProvider = {
        name: 'tsc',
        store: new ProblemStore(),
        scanning: false,
        autoScan: false,
        enabled: true,
        capabilities: { extensions: ['.ts'] },
        onDidUpdate: () => ({ dispose: () => {} }),
        onDidProgressScan: progressEmitter.event,
        initialize: () => {},
        start: () => {},
        stop: () => {},
        refresh: () => {},
        dispose: () => {},
      };
      manager.register('tsc', provider, { priority: 10 });

      progressEmitter.fire({ providerName: 'tsc', phase: 'resolving' });
      progressEmitter.fire({ providerName: 'tsc', phase: 'cancelled' });

      const cancelEvents = collected.filter((e) => e.type === 'autoscan.cancel');
      assert.ok(cancelEvents.length >= 1, 'Expected autoscan.cancel event');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  DiagnosticsMonitor                                                 */
  /* ------------------------------------------------------------------ */

  suite('DiagnosticsMonitor', () => {
    test('publishes diagnostics.updateUri when vscodeDiagnostics provider fires onDidUpdate', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDiagnosticsMonitor(manager, reporter);

      // Register the vscodeDiagnostics provider
      const updateEmitter = new EventEmitter<Uri[]>();
      const progressEmitter = new EventEmitter<ScanProgress>();
      const store = new ProblemStore();
      const provider3: DiagnosticProvider = {
        name: 'vscodeDiagnostics',
        store,
        scanning: false,
        autoScan: false,
        enabled: true,
        capabilities: { extensions: [] },
        onDidUpdate: updateEmitter.event,
        onDidProgressScan: progressEmitter.event,
        initialize: () => {},
        start: () => {},
        stop: () => {},
        refresh: () => {},
        dispose: () => {},
      };
      manager.register('vscodeDiagnostics', provider3, { priority: 5 });

      // Fire onDidUpdate — triggers diagnostics.updateUri
      const uri = Uri.parse('file:///project/test.ts');
      updateEmitter.fire([uri]);

      const updateEvents = collected.filter((e) => e.type === 'diagnostics.updateUri');
      assert.ok(updateEvents.length >= 1, 'Expected diagnostics.updateUri event');
    });

    test('publishes diagnostics.fullScan when provider has pending scan and many URIs', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDiagnosticsMonitor(manager, reporter);

      const updateEmitter = new EventEmitter<Uri[]>();
      const progressEmitter = new EventEmitter<ScanProgress>();
      const store = new ProblemStore();
      const provider: DiagnosticProvider = {
        name: 'vscodeDiagnostics',
        store,
        scanning: false,
        autoScan: false,
        enabled: true,
        capabilities: { extensions: [] },
        onDidUpdate: updateEmitter.event,
        onDidProgressScan: progressEmitter.event,
        initialize: () => {},
        start: () => {},
        stop: () => {},
        refresh: () => {},
        dispose: () => {},
      };
      manager.register('vscodeDiagnostics', provider, { priority: 5 });

      // Trigger a pending scan, then fire onDidUpdate with many URIs
      progressEmitter.fire({ providerName: 'vscodeDiagnostics', phase: 'resolving' });
      const uris: Uri[] = [];
      for (let i = 0; i < 25; i++) {
        uris.push(Uri.parse(`file:///project/file${i}.ts`));
      }
      updateEmitter.fire(uris);

      const fullScanEvents = collected.filter((e) => e.type === 'diagnostics.fullScan');
      assert.ok(fullScanEvents.length >= 1, 'Expected diagnostics.fullScan event');
      const payload = fullScanEvents[0] as any;
      assert.strictEqual(payload.uriCount, 25);
    });

    test('publishes diagnostics.flushUpdates on onDidUpdateAll', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDiagnosticsMonitor(manager, reporter);

      // Fire the onDidUpdateAll event directly (private EventEmitter)
      const uris = [Uri.parse('file:///project/test.ts')];
      (manager as any)._onDidUpdateAll.fire(uris);

      const flushEvents = collected.filter((e) => e.type === 'diagnostics.flushUpdates');
      assert.ok(flushEvents.length >= 1, 'Expected diagnostics.flushUpdates event');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  DecorationMonitor                                                  */
  /* ------------------------------------------------------------------ */

  suite('DecorationMonitor', () => {
    test('wraps fireDidChange and publishes decoration.refresh.start', () => {
      const store = new ProblemStore();
      const engine = new DecorationEngine(store, { getWorkspaceFolder: () => undefined });
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDecorationMonitor(engine, reporter);

      const uri = Uri.parse('file:///project/a.ts');
      engine.fireDidChange(uri);

      const fireEvents = collected.filter((e) => e.type === 'decoration.refresh.start');
      assert.strictEqual(fireEvents.length, 1, 'Expected one decoration.refresh.start event');
      const payload = fireEvents[0] as any;
      assert.strictEqual(payload.callType, 'single');
      assert.strictEqual(payload.uriCount, 1);
    });

    test('wraps fireDidChange with array and full refresh', () => {
      const store = new ProblemStore();
      const engine = new DecorationEngine(store, { getWorkspaceFolder: () => undefined });
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDecorationMonitor(engine, reporter);

      engine.fireDidChange([Uri.parse('file:///project/a.ts'), Uri.parse('file:///project/b.ts')]);
      engine.fireDidChange(undefined);

      const fireEvents = collected.filter((e) => e.type === 'decoration.refresh.start');
      assert.strictEqual(fireEvents.length, 2);
      assert.strictEqual((fireEvents[0] as any).callType, 'array');
      assert.strictEqual((fireEvents[0] as any).uriCount, 2);
      assert.strictEqual((fireEvents[1] as any).callType, 'full');
    });

    test('wraps provideFileDecoration and publishes decoration.provide', () => {
      const store = new ProblemStore();
      const engine = new DecorationEngine(store, { getWorkspaceFolder: () => undefined });
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDecorationMonitor(engine, reporter);

      const uri = Uri.parse('file:///project/a.ts');
      const token = new CancellationTokenSource().token;
      engine.provideFileDecoration(uri, token);

      const provideEvents = collected.filter((e) => e.type === 'decoration.provide');
      assert.strictEqual(provideEvents.length, 1, 'Expected one decoration.provide event');
      const payload = provideEvents[0] as any;
      assert.strictEqual(payload.uri, uri.toString());
      assert.ok(typeof payload.hit === 'boolean');
      assert.ok(typeof payload.executionTimeMs === 'number');
    });

    test('provideFileDecoration with undefined result publishes hit=false', () => {
      const store = new ProblemStore();
      const engine = new DecorationEngine(store, { getWorkspaceFolder: () => undefined });
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createDecorationMonitor(engine, reporter);

      // URI not in store — provideFileDecoration returns undefined
      const uri = Uri.parse('file:///project/unknown.ts');
      engine.provideFileDecoration(uri, new CancellationTokenSource().token);

      const provideEvents = collected.filter((e) => e.type === 'decoration.provide');
      assert.strictEqual(provideEvents.length, 1);
      assert.strictEqual((provideEvents[0] as any).hit, false);
    });

    test('restores original methods on dispose', () => {
      const store = new ProblemStore();
      const engine = new DecorationEngine(store, { getWorkspaceFolder: () => undefined });
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);

      const originalFire = engine.fireDidChange;
      const originalProvide = engine.provideFileDecoration;

      const monitor = createDecorationMonitor(engine, reporter);
      assert.notStrictEqual(engine.fireDidChange, originalFire, 'fireDidChange should be replaced');
      assert.notStrictEqual(engine.provideFileDecoration, originalProvide, 'provideFileDecoration should be replaced');

      monitor.dispose();
      assert.strictEqual(engine.fireDidChange, originalFire, 'fireDidChange should be restored');
      assert.strictEqual(engine.provideFileDecoration, originalProvide, 'provideFileDecoration should be restored');
    });

    test('disposed monitor delegates to original without publishing events', () => {
      const store = new ProblemStore();
      const engine = new DecorationEngine(store, { getWorkspaceFolder: () => undefined });
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));

      const monitor = createDecorationMonitor(engine, reporter);
      monitor.dispose();

      engine.fireDidChange(Uri.parse('file:///project/a.ts'));
      engine.provideFileDecoration(Uri.parse('file:///project/a.ts'), new CancellationTokenSource().token);

      const events = collected.filter(
        (e) => e.type.startsWith('decoration.'),
      );
      assert.strictEqual(events.length, 0, 'No decoration events after dispose');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  FolderMonitor                                                      */
  /* ------------------------------------------------------------------ */

  suite('FolderMonitor', () => {
    test('wraps updateAncestors and publishes folder.updateAncestors', () => {
      const store = new ProblemStore();
      const wf = {
        getWorkspaceFolder: () => undefined,
        workspaceFolders: [] as any[],
      };
      const folderManager = new FolderStatusManager(store, wf);
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createFolderMonitor(folderManager, store, reporter);

      // Set up store entry so updateAncestors has something to process
      const uri = Uri.parse('file:///project/a.ts');
      store.set(uri, makeState());

      // updateAncestors with no workspace folder returns empty - but event still fires
      folderManager.updateAncestors(uri);

      const updateEvents = collected.filter((e) => e.type === 'folder.updateAncestors');
      assert.strictEqual(updateEvents.length, 1, 'Expected one folder.updateAncestors event');

      const payload = updateEvents[0] as any;
      assert.strictEqual(payload.uri, uri.toString());
      assert.ok(typeof payload.changedCount === 'number');
      assert.ok(typeof payload.executionTimeMs === 'number');
    });

    test('wraps rebuildAll and publishes folder.rebuildAll', () => {
      const store = new ProblemStore();
      const wf = {
        getWorkspaceFolder: () => undefined,
        workspaceFolders: [] as any[],
      };
      const folderManager = new FolderStatusManager(store, wf);
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));
      createFolderMonitor(folderManager, store, reporter);

      folderManager.rebuildAll();

      const rebuildEvents = collected.filter((e) => e.type === 'folder.rebuildAll');
      assert.strictEqual(rebuildEvents.length, 1, 'Expected one folder.rebuildAll event');

      const payload = rebuildEvents[0] as any;
      assert.ok(typeof payload.changedCount === 'number');
      assert.ok(typeof payload.executionTimeMs === 'number');
    });

    test('restores original methods on dispose', () => {
      const store = new ProblemStore();
      const wf = {
        getWorkspaceFolder: () => undefined,
        workspaceFolders: [] as any[],
      };
      const folderManager = new FolderStatusManager(store, wf);
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);

      const originalUpdate = folderManager.updateAncestors;
      const originalRebuild = folderManager.rebuildAll;

      const monitor = createFolderMonitor(folderManager, store, reporter);
      assert.notStrictEqual(folderManager.updateAncestors, originalUpdate);
      assert.notStrictEqual(folderManager.rebuildAll, originalRebuild);

      monitor.dispose();
      assert.strictEqual(folderManager.updateAncestors, originalUpdate);
      assert.strictEqual(folderManager.rebuildAll, originalRebuild);
    });

    test('disposed monitor delegates to original without publishing events', () => {
      const store = new ProblemStore();
      const wf = {
        getWorkspaceFolder: () => undefined,
        workspaceFolders: [] as any[],
      };
      const folderManager = new FolderStatusManager(store, wf);
      const reporter = new BusTelemetryReporter(makeConfigManager(), bus);
      reporter.subscribeAll((e) => collected.push(e));

      const monitor = createFolderMonitor(folderManager, store, reporter);
      monitor.dispose();

      const uri = Uri.parse('file:///project/a.ts');
      folderManager.updateAncestors(uri);
      folderManager.rebuildAll();

      const events = collected.filter((e) => e.type.startsWith('folder.'));
      assert.strictEqual(events.length, 0, 'No folder events after dispose');
    });
  });
});
