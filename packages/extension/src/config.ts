import type { EngineConfig } from '@pe/api';

import type { BadgeStyle } from './badge.js';
import type { SeverityOverrides } from './severity.js';

export interface TscProviderSettings {
  readonly enabled: boolean;
  readonly autoScan: boolean;
  readonly scanOnStartup: boolean;
  readonly timeout: number;
  readonly extraArgs: readonly string[];
}

export interface EslintProviderSettings {
  readonly enabled: boolean;
  readonly autoScan: boolean;
  readonly scanOnStartup: boolean;
  readonly timeout: number;
  readonly extraArgs: readonly string[];
}

export interface ExtensionConfig {
  readonly enabled: boolean;
  readonly showWarnings: boolean;
  readonly badgeStyle: BadgeStyle;
  readonly ignorePatterns: readonly string[];
  readonly severityOverrides: SeverityOverrides | undefined;
  readonly autoScanEnabled: boolean;
  readonly autoScanDelay: number;
  readonly debug: boolean;
  readonly typescript: TscProviderSettings;
  readonly eslint: EslintProviderSettings;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  showWarnings: true,
  badgeStyle: 'letter',
  ignorePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/target/**',
    '**/__pycache__/**',
    '**/vendor/**',
    '**/.tox/**',
  ],
  severityOverrides: undefined,
  autoScanEnabled: true,
  autoScanDelay: 2000,
  debug: false,
  typescript: {
    enabled: true,
    autoScan: true,
    scanOnStartup: true,
    timeout: 120_000,
    extraArgs: [],
  },
  eslint: {
    enabled: true,
    autoScan: true,
    scanOnStartup: false,
    timeout: 120_000,
    extraArgs: [],
  },
};

/** Generic settings reader, implemented against vscode.workspace in extension.ts. */
export interface SettingsReader {
  get<T>(key: string, fallback: T): T;
}

const prefix = (key: string): string => `problemExplorer.${key}`;

const problemExplorerKeys = {
  enabled: 'enabled',
  showWarnings: 'showWarnings',
  badgeStyle: 'badgeStyle',
  ignorePatterns: 'ignorePatterns',
  severityOverrides: 'severityOverrides',
  autoScanEnabled: 'autoScan.enabled',
  autoScanDelay: 'autoScanDelay',
  debug: 'debug',
  tscEnabled: 'typescript.enabled',
  tscAutoScan: 'typescript.autoScan',
  tscScanOnStartup: 'typescript.scanOnStartup',
  tscTimeout: 'typescript.timeout',
  tscExtraArgs: 'typescript.extraArgs',
  eslintEnabled: 'eslint.enabled',
  eslintAutoScan: 'eslint.autoScan',
  eslintScanOnStartup: 'eslint.scanOnStartup',
  eslintTimeout: 'eslint.timeout',
  eslintExtraArgs: 'eslint.extraArgs',
} as const;

export function readConfig(reader: SettingsReader): ExtensionConfig {
  return {
    enabled: reader.get(problemExplorerKeys.enabled, DEFAULT_CONFIG.enabled),
    showWarnings: reader.get(problemExplorerKeys.showWarnings, DEFAULT_CONFIG.showWarnings),
    badgeStyle: reader.get(problemExplorerKeys.badgeStyle, DEFAULT_CONFIG.badgeStyle),
    ignorePatterns: reader.get(problemExplorerKeys.ignorePatterns, DEFAULT_CONFIG.ignorePatterns),
    severityOverrides: reader.get(
      problemExplorerKeys.severityOverrides,
      DEFAULT_CONFIG.severityOverrides,
    ),
    autoScanEnabled: reader.get(
      problemExplorerKeys.autoScanEnabled,
      DEFAULT_CONFIG.autoScanEnabled,
    ),
    autoScanDelay: reader.get(problemExplorerKeys.autoScanDelay, DEFAULT_CONFIG.autoScanDelay),
    debug: reader.get(problemExplorerKeys.debug, DEFAULT_CONFIG.debug),
    typescript: {
      enabled: reader.get(problemExplorerKeys.tscEnabled, DEFAULT_CONFIG.typescript.enabled),
      autoScan: reader.get(problemExplorerKeys.tscAutoScan, DEFAULT_CONFIG.typescript.autoScan),
      scanOnStartup: reader.get(
        problemExplorerKeys.tscScanOnStartup,
        DEFAULT_CONFIG.typescript.scanOnStartup,
      ),
      timeout: reader.get(problemExplorerKeys.tscTimeout, DEFAULT_CONFIG.typescript.timeout),
      extraArgs: reader.get(problemExplorerKeys.tscExtraArgs, DEFAULT_CONFIG.typescript.extraArgs),
    },
    eslint: {
      enabled: reader.get(problemExplorerKeys.eslintEnabled, DEFAULT_CONFIG.eslint.enabled),
      autoScan: reader.get(
        problemExplorerKeys.eslintAutoScan,
        DEFAULT_CONFIG.eslint.autoScan,
      ),
      scanOnStartup: reader.get(
        problemExplorerKeys.eslintScanOnStartup,
        DEFAULT_CONFIG.eslint.scanOnStartup,
      ),
      timeout: reader.get(problemExplorerKeys.eslintTimeout, DEFAULT_CONFIG.eslint.timeout),
      extraArgs: reader.get(
        problemExplorerKeys.eslintExtraArgs,
        DEFAULT_CONFIG.eslint.extraArgs,
      ),
    },
  };
}

/** Engine tuning knobs derived from the extension config. */
export function toEngineConfig(config: ExtensionConfig): EngineConfig {
  const maxConcurrency = {
    cheap: 4,
    medium: 2,
    expensive: 1,
  } as const;
  return {
    debounceMs: config.autoScanDelay,
    batchMs: 50,
    idleWindowMs: 2000,
    queueSize: 100,
    scanTimeoutMs: Math.max(config.typescript.timeout, config.eslint.timeout),
    maxConcurrency,
  };
}

/** Provider ids to register, in registration order (realtime first). Disabled providers are excluded entirely so ownership falls back to the editor. */
export function providerList(config: ExtensionConfig): string[] {
  const ids = ['vscode'];
  if (config.typescript.enabled) {
    ids.push('tsc');
  }
  if (config.eslint.enabled) {
    ids.push('eslint');
  }
  return ids;
}