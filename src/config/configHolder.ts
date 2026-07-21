import { ConfigManager } from './configManager';

let configManager: ConfigManager | undefined;

export function setConfigManager(mgr: ConfigManager): void {
  configManager = mgr;
}

export function getConfigManager(): ConfigManager | undefined {
  return configManager;
}

