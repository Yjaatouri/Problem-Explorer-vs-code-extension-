import * as assert from 'assert';
import { Uri, EventEmitter } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { VSDiagnosticsProvider } from '../../providers/VSDiagnosticsProvider';
import { ApiManager } from '../../api/problemExplorerApi';
import { StatusBarManager } from '../../statusBar/statusBarManager';
import { TrendTracker } from '../../trend/trendTracker';
import { MementoStorageProvider } from '../../trend/trendTracker';
import { AutoScanController } from '../../scanner/AutoScanner';

const rootUri = Uri.parse('file:///workspace');
const file1 = Uri.parse('file:///workspace/src/a.ts');
const file2 = Uri.parse('file:///workspace/src/b.ts');
const file3 = Uri.parse('file:///workspace/src/c.ts');

function workspaceFolderDelegate() {
  return {
    getWorkspaceFolder: (uri: Uri) =>
      uri.toString().startsWith(rootUri.toString() + '/')
        ? { uri: rootUri, name: 'workspace', index: 0 }
        : undefined,
    workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
  };
}

class MockSlowProvider {
  readonly name = 'tsc';
  readonly capabilities = { extensions: ['.ts', '.tsx'], realtime: false, manualScan: true, startupScan: true, fullWorkspace: true };
  private readonly _store: ProblemStore;
  private readonly _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;
  private readonly _onDidProgressScan = new EventEmitter<any>();
  readonly onDidProgressScan = this._onDidProgressScan.event;
  private _disposed = false;
  private _scanning = false;
  private _enabled = true;
  private _autoScan = true;
  private _scanDelayMs = 50;
  private _fileCounter = 0;

  constructor(store: ProblemStore) {
    this._store = store;
  }

  get store(): ProblemStore {
    return this._store;
  }

  get scanning(): boolean {
    return this._scanning;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get autoScan(): boolean {
    return this._autoScan;
  }

  initialize(): void {
    this._runScan();
  }

  start(): void {}

  stop(): void {
    this._scanning = false;
  }

  refresh(): void | Promise<void> {
    this._runScan();
  }

  dispose(): void {
    this._disposed = true;
    this._onDidUpdate.dispose();
    this._onDidProgressScan.dispose();
  }

  releaseOwnership(): void {
    this._store.releaseOwnership(this.name);
  }

  setScanDelay(ms: number): void {
    this._scanDelayMs = ms;
  }

  private async _runScan(): Promise<void> {
    if (this._disposed || !this._enabled) return;
    this._scanning = true;

    await new Promise(resolve => setTimeout(resolve, this._scanDelayMs));

    const file = this._fileCounter % 3 === 0 ? file1 : (this._fileCounter % 3 === 1 ? file2 : file3);
    this._fileCounter++;

    const state = { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 };
    const changed = this._store.set(file, state, this.name);

    if (changed) {
      this._onDidUpdate.fire([file]);
    }

    this._scanning = false;
  }
}

suite('ConcurrentAutoScan', () => {
  let store: ProblemStore;
  let manager: DiagnosticProviderManager;
  let folderStatusManager: FolderStatusManager;
  let decorationEngine: DecorationEngine;
  let vsDiagProvider: VSDiagnosticsProvider;
  let apiManager: ApiManager;
  let statusBarManager: StatusBarManager;
  let trendTracker: TrendTracker;

  setup(() => {
    store = new ProblemStore();
    manager = new DiagnosticProviderManager();
    folderStatusManager = new FolderStatusManager(store, workspaceFolderDelegate());
    decorationEngine = new DecorationEngine(store, workspaceFolderDelegate());
    apiManager = new ApiManager(store);
    statusBarManager = new StatusBarManager(store);
    trendTracker = new TrendTracker(store, new MementoStorageProvider({} as any));

    store.configureProvider('tsc', 10);
  });

  teardown(() => {
    manager.dispose();
    decorationEngine.dispose();
    statusBarManager.dispose();
    trendTracker.stop();
  });

  test('Concurrent saves during active scan do not drop providers (regression for _flushing bug)', async () => {
    const tscProvider = new MockSlowProvider(store);
    tscProvider.setScanDelay(100);
    manager.register('tsc', tscProvider, { priority: 10, capabilities: ['diagnostics', 'tsc-scan'] });

    await manager.initializeAll();
    manager.startAll();

    const vsDiagProvider = new VSDiagnosticsProvider(
      manager,
      folderStatusManager,
      apiManager,
      decorationEngine,
      statusBarManager,
      trendTracker,
      () => {},
    );
    vsDiagProvider.start();

    const autoScan = new AutoScanController(manager, statusBarManager, () => {}, 10, true);
    autoScan.start();

    (autoScan as any).onFileChanged(file1);
    await new Promise(resolve => setTimeout(resolve, 10));

    (autoScan as any).onFileChanged(file2);
    await new Promise(resolve => setTimeout(resolve, 10));

    (autoScan as any).onFileChanged(file3);
    await new Promise(resolve => setTimeout(resolve, 10));

    await new Promise(resolve => setTimeout(resolve, 350));

    const file1State = store.get(file1);
    const file2State = store.get(file2);
    const file3State = store.get(file3);

    assert.ok(file1State, 'File 1 should be scanned after concurrent saves');
    assert.ok(file2State, 'File 2 should be scanned after concurrent saves');
    assert.ok(file3State, 'File 3 should be scanned after concurrent saves');

    assert.strictEqual(file1State.severity, ProblemSeverity.Error);
    assert.strictEqual(file2State.severity, ProblemSeverity.Error);
    assert.strictEqual(file3State.severity, ProblemSeverity.Error);

    autoScan.dispose();
  });

  test('AutoScanController re-schedules flush when new saves arrive during flush', async () => {
    const tscProvider = new MockSlowProvider(store);
    tscProvider.setScanDelay(80);
    manager.register('tsc', tscProvider, { priority: 10, capabilities: ['diagnostics', 'tsc-scan'] });

    await manager.initializeAll();
    manager.startAll();

    const vsDiagProvider = new VSDiagnosticsProvider(
      manager,
      folderStatusManager,
      apiManager,
      decorationEngine,
      statusBarManager,
      trendTracker,
      () => {},
    );
    vsDiagProvider.start();

    const autoScan = new AutoScanController(manager, statusBarManager, () => {}, 5, true);
    autoScan.start();

    (autoScan as any).onFileChanged(file1);
    await new Promise(resolve => setTimeout(resolve, 5));

    (autoScan as any).onFileChanged(file2);
    await new Promise(resolve => setTimeout(resolve, 5));

    (autoScan as any).onFileChanged(file3);
    await new Promise(resolve => setTimeout(resolve, 5));

    await new Promise(resolve => setTimeout(resolve, 300));

    const states = [store.get(file1), store.get(file2), store.get(file3)];
    const allScanned = states.every(s => s !== undefined);
    assert.ok(allScanned, 'All three files should be scanned despite rapid concurrent saves');

    autoScan.dispose();
  });
});