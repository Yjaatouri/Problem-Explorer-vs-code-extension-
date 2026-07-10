import * as vscode from 'vscode';
import { ProblemCache } from './cache/cacheLayer';
import { DiagnosticsManager } from './diagnostics/diagnosticsManager';
import { DecorationEngine } from './decoration/decorationEngine';

export function activate(context: vscode.ExtensionContext): void {
  const cache = new ProblemCache();
  const diagnosticsManager = new DiagnosticsManager(cache);
  const decorationEngine = new DecorationEngine(cache);

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationEngine),
  );

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      const changed = diagnosticsManager.processChanges(e);
      if (changed.length > 0) {
        decorationEngine.fireDidChange(changed);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('problemExplorer.refresh', () => {
      diagnosticsManager.fullScan();
      decorationEngine.refresh();
    }),
  );

  const changed = diagnosticsManager.fullScan();
  if (changed.length > 0) {
    decorationEngine.fireDidChange(changed);
  }
}

export function deactivate(): void {
  // All disposables in context.subscriptions are cleaned up automatically
}
