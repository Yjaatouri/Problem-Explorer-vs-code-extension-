import * as vscode from 'vscode';

import type { DiagnosticsAPI, Uri } from '@pe/api';

import { readConfig } from './config.js';
import type { ExtensionConfig, SettingsReader } from './config.js';
import { createEngine, startScans } from './engine.js';
import type { EngineApi } from './engine.js';
import { DecorationEngine } from './decorations.js';
import { StatusBarManager } from './statusBar.js';
import { RealtimeDiagnosticsBridge } from './realtime.js';
import type { LanguagesBridge } from './realtime.js';
import { isIgnored } from './ignore.js';
import { registerCommands } from './commands.js';

class VscodeDecorationAdapter implements vscode.FileDecorationProvider {
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

  constructor(private readonly engine: DecorationEngine) {
    this.onDidChangeFileDecorations = this.emitter.event;
    this.engine.setUpdater((uris) => {
      this.emitter.fire(uris as vscode.Uri | vscode.Uri[] | undefined);
    });
  }

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken,
  ): vscode.FileDecoration | undefined {
    const rendered = this.engine.provideFileDecoration(uri);
    if (!rendered) {
      return undefined;
    }
    return {
      badge: rendered.badge,
      color: new vscode.ThemeColor(rendered.color),
      tooltip: rendered.tooltip,
      propagate: false,
    };
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function makeSettingsReader(settings: vscode.WorkspaceConfiguration): SettingsReader {
  return {
    get: <T>(key: string, fallback: T): T => {
      const value = settings.get<T>(key);
      return value === undefined ? fallback : value;
    },
  };
}

/**
 * Live host handle returned from `activate()`. The engine instance swaps on
 * config rebuilds — always reach it through `api()`, never cache the value.
 */
export interface HostApi {
  /** Current engine API (undefined while disabled or pre-creation). */
  api(): DiagnosticsAPI | undefined;
  /** Render a URI through the registered VS Code FileDecorationProvider. */
  renderDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
  /** Current status bar text. */
  statusText(): string | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<HostApi | undefined> {
  const output = vscode.window.createOutputChannel('Problem Explorer');
  context.subscriptions.push(output);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    return undefined;
  }

  let config: ExtensionConfig = readConfig(
    makeSettingsReader(vscode.workspace.getConfiguration('problemExplorer')),
  );

  // -------- engine slot (rebuildable on config change) --------
  let engine: EngineApi | undefined;
  const engineProvider = {
    getApi: (): EngineApi['api'] | undefined => engine?.api,
  };

  // -------- realtime bridge --------
  const languages: LanguagesBridge = {
    getDiagnostics: (uri) => vscode.languages.getDiagnostics(uri as vscode.Uri),
  };
  const bridge = new RealtimeDiagnosticsBridge(
    () => engine,
    workspaceRoot,
    languages,
    (uri) => isIgnored(uri, config.ignorePatterns),
    config.severityOverrides,
  );
  bridge.attach((listener) =>
    vscode.languages.onDidChangeDiagnostics((e) => listener(e.uris)),
  );

  // -------- decorations --------
  const decorationEngine = new DecorationEngine(
    {
      getProblems: (uri) => engine && engine.api.getProblems(uri as Uri),
    },
    (uri) => !!vscode.workspace.getWorkspaceFolder(uri as vscode.Uri),
  );
  const decorationAdapter = new VscodeDecorationAdapter(decorationEngine);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationAdapter),
    decorationAdapter,
    decorationEngine,
  );

  // -------- status bar --------
  const statusBar = new StatusBarManager(
    { getTotals: () => engineProvider.getApi()?.getTotals() ?? { errors: 0, warnings: 0, info: 0 } },
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0),
  );
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('problemExplorer.showStatus', () => {
      void vscode.commands.executeCommand('workbench.action.views.problems');
    }),
  );

  // -------- config change -> rebuild --------
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('problemExplorer')) {
        return;
      }
      config = readConfig(makeSettingsReader(vscode.workspace.getConfiguration('problemExplorer')));
      statusBar.setEnabled(config.enabled);
      decorationEngine.setConfig(config);
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
      }
      rebuildTimer = setTimeout(() => {
        rebuildEngine();
      }, 300);
    }),
  );

  // -------- auto scans --------
  const scanUri = (uri: vscode.Uri): void => {
    if (!config.autoScanEnabled || isIgnored(uri, config.ignorePatterns)) {
      return;
    }
    engine?.api.scanOnSave(uri);
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      scanUri(document.uri);
    }),
    vscode.workspace.onDidCreateFiles((e) => {
      for (const uri of e.files) {
        scanUri(uri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) {
        engine?.api.scanOnSave(uri);
      }
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const move of e.files) {
        engine?.api.scanOnSave(move.newUri);
      }
    }),
  );

  // -------- commands --------
  registerCommands(
    vscode.commands,
    engineProvider,
    { showInformationMessage: (m) => void vscode.window.showInformationMessage(m) },
    {
      isEnabled: () => config.enabled,
      setEnabled: async (enabled) => {
        await vscode.workspace
          .getConfiguration('problemExplorer')
          .update('enabled', enabled, vscode.ConfigurationTarget.Global);
      },
    },
  );

  // -------- engine lifecycle --------
  function rebuildEngine(): void {
    if (engine) {
      engine.api.dispose();
      engine = undefined;
    }
    if (!config.enabled) {
      decorationEngine.notifyChanged(undefined);
      statusBar.setEnabled(false);
      return;
    }
    const next = createEngine(workspaceRoot!, config);
    next.api.onTotalsChanged(() => {
      statusBar.update();
      decorationEngine.notifyChanged(undefined);
    });
    next.api.onScanStateChanged((state) => {
      statusBar.setScanning(state.phase === 'scanning');
    });
    engine = next;
    decorationEngine.notifyChanged(undefined);
    statusBar.setEnabled(true);
    void startScans(next, config);
  }

  // -------- boot --------
  statusBar.setEnabled(config.enabled);
  decorationEngine.setConfig(config);
  rebuildEngine();
  // A real (uncancelled) token; `provideFileDecoration` is sync, so the
    // token value doesn't matter for rendering.
    const renderToken = new vscode.CancellationTokenSource().token;
    return {
      api: () => engine?.api,
      renderDecoration: (uri) => decorationAdapter.provideFileDecoration(uri, renderToken),
      statusText: () => statusBar.text,
    };
}