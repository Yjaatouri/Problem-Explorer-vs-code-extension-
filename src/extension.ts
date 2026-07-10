import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Problem Explorer] Activating...');

  context.subscriptions.push(
    vscode.commands.registerCommand('problemExplorer.refresh', () => {
      console.log('[Problem Explorer] Refresh command executed');
    })
  );

  console.log('[Problem Explorer] Activation complete');
}

export function deactivate(): void {
  console.log('[Problem Explorer] Deactivating...');
}
