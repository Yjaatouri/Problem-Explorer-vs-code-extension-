import { ScanType } from '@pe/provider-sdk';

import type { DiagnosticsAPI } from '@pe/api';

import type { DisposableLike } from './types.js';

export interface CommandRegister {
  registerCommand(id: string, handler: (...args: never[]) => unknown): DisposableLike;
}

export interface ShowInformation {
  showInformationMessage(message: string): void;
}

export interface EngineProvider {
  getApi(): DiagnosticsAPI | undefined;
}

export interface ToggleConfigWriter {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void>;
}

/** Command handlers — no vscode imports; extension.ts wires the vscode bits. */
export function registerCommands(
  commands: CommandRegister,
  engine: EngineProvider,
  info: ShowInformation,
  toggle: ToggleConfigWriter,
): DisposableLike[] {
  const disposables: DisposableLike[] = [];

  disposables.push(
    commands.registerCommand('problemExplorer.refresh', async () => {
      await engine.getApi()?.rescanAll();
    }),
  );

  disposables.push(
    commands.registerCommand('problemExplorer.scanWorkspace', async () => {
      const api = engine.getApi();
      if (!api) {
        return;
      }
      await api.scan(ScanType.Manual);
      info.showInformationMessage('Problem Explorer: workspace scan started');
    }),
  );

  disposables.push(
    commands.registerCommand('problemExplorer.toggle', async () => {
      await toggle.setEnabled(!toggle.isEnabled());
    }),
  );

  return disposables;
}