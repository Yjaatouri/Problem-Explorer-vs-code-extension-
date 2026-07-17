import { ConfigManager } from './configManager';

let configManager: ConfigManager | undefined;

export function setConfigManager(mgr: ConfigManager): void {
  configManager = mgr;
}

export function getConfigManager(): ConfigManager | undefined {
  return configManager;
}

export function isDebugEnabled(): boolean {
  return configManager?.getConfig().debug ?? false;
}

export function debugLog(msg: string): void {
  if (isDebugEnabled()) {
    console.log(msg);
  }
}