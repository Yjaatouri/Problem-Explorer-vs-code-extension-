import { DiagnosticsAPI } from '@pe/api';

import type { Provider, Uri } from '@pe/api';
import { TscProvider } from '@pe/provider-tsc';
import { EslintProvider } from '@pe/provider-eslint';
import { RealtimeDiagnosticsProvider } from '@pe/provider-vscode-realtime';
import { ScanType } from '@pe/provider-sdk';

import type { ExtensionConfig } from './config.js';
import { toEngineConfig, providerList } from './config.js';

export interface EngineApi {
  readonly api: DiagnosticsAPI;
  readonly realtime: RealtimeDiagnosticsProvider;
}

/** Build the @pe DiagnosticsAPI for the current config. `providerList` decides which providers are registered. */
export function createEngine(
  workspaceRoot: Uri,
  config: ExtensionConfig,
): EngineApi {
  const realtime = new RealtimeDiagnosticsProvider();
  const providers: Provider[] = [realtime];
  for (const id of providerList(config)) {
    if (id === 'tsc') {
      providers.push(
        new TscProvider({
          enabled: config.typescript.enabled,
          extraArgs: config.typescript.extraArgs,
          timeoutMs: config.typescript.timeout,
        }),
      );
    } else if (id === 'eslint') {
      providers.push(
        new EslintProvider({
          enabled: config.eslint.enabled,
          extraArgs: config.eslint.extraArgs,
          timeoutMs: config.eslint.timeout,
        }),
      );
    }
  }

  const api = new DiagnosticsAPI({
    workspaceRoot,
    providers,
    config: toEngineConfig(config),
  });

  return { api, realtime };
}

export async function startScans(engine: EngineApi, config: ExtensionConfig): Promise<void> {
  const manualStartup = config.typescript.scanOnStartup || config.eslint.scanOnStartup;
  if (manualStartup) {
    await engine.api.scan(ScanType.Startup);
  }
}