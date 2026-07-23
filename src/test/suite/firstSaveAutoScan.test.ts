import * as assert from 'assert';
import * as vscode from 'vscode';
import { Uri, Diagnostic, EventEmitter } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { ProblemSeverity } from '../../core/types';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { TscDiagnosticProvider } from '../../providers/TscDiagnosticProvider';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { VSDiagnosticsProvider } from '../../providers/VSDiagnosticsProvider';
import { ApiManager } from '../../api/problemExplorerApi';
import { StatusBarManager } from '../../statusBar/statusBarManager';
import { TrendTracker } from '../../trend/trendTracker';
import { MementoStorageProvider } from '../../trend/trendTracker';

const rootUri = Uri.parse('file:///workspace');
const testFile = Uri.parse('file:///workspace/src/test.ts');

function workspaceFolderDelegate() {
  return {
    getWorkspaceFolder: (uri: Uri) =>
      uri.toString().startsWith(rootUri.toString() + '/')
        ? { uri: rootUri, name: 'workspace', index: 0 }
        : undefined,
    workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
  };
}

class MockTscRunner {
  private readonly diagnostics: Map<string, any[]>;

  constructor(diagnostics: Map<string, any[]>) {
    this.diagnostics = diagnostics;
  }

  async run(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    cancelled: boolean;
    timedOut: boolean;
  }> {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      cancelled: false,
      timedOut: false,
    };
  }
}

class MockProjectResolver {
  private readonly projects: any[];

  constructor(projects: any[]) {
    this.projects = projects;
  }

  async resolveAll(): Promise<any[]> {
    return this.projects;
  }
}

class TestTscProvider {
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
  private _refreshDebounceMs = 10;

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

  private async _runScan(): Promise<void> {
    if (this._disposed || !this._enabled) return;
    this._scanning = true;

    await new Promise(resolve => setTimeout(resolve, this._refreshDebounceMs));

    const state = { severity: ProblemSeverity.Error, errorCount: 1, warningCount: 0, infoCount: 0, fileCount: 1 };
    const changed = this._store.set(testFile, state, this.name);

    if (changed) {
      this._onDidUpdate.fire([testFile]);
    }

    this._scanning = false;
  }
}

suite('FirstSaveAutoScan', () => {
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

  test('First save after reload → auto-scan produces file decoration', async () => {
    const tscProvider = new TestTscProvider(store);
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

    assert.strictEqual(store.get(testFile), undefined, 'Store should be empty initially');

    tscProvider.refresh();
    await new Promise(resolve => setTimeout(resolve, 50));

    const fileState = store.get(testFile);
    assert.ok(fileState, 'File should have error state after auto-scan');
    assert.strictEqual(fileState.severity, ProblemSeverity.Error);
    assert.strictEqual(fileState.errorCount, 1);

    const decoration = decorationEngine.provideFileDecoration(testFile, {} as any);
    assert.ok(decoration, 'DecorationEngine should return decoration for file with errors');
    assert.strictEqual(decoration.badge, 'E');
    assert.ok(decoration.color);

    const folderDecoration = decorationEngine.provideFileDecoration(rootUri, {} as any);
    assert.ok(folderDecoration, 'DecorationEngine should return decoration for folder aggregate');
  });

  test('Auto-scan chain: _onDidUpdate → DPM → VSDiag → updateAncestors → fireDidChange → provideFileDecoration', async () => {
    const tscProvider = new TestTscProvider(store);
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

    tscProvider.refresh();
    await new Promise(resolve => setTimeout(resolve, 50));

    const fileState = store.get(testFile);
    assert.ok(fileState);

    const folderState = store.get(rootUri);
    assert.ok(folderState, 'Folder aggregate should be created by updateAncestors');
    assert.strictEqual(folderState.severity, ProblemSeverity.Error);
  });
});