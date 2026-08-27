import {
  ConfigurationChangeEvent,
  Disposable,
  Event,
  EventEmitter,
  workspace,
} from 'vscode';
import { Config, EslintConfig, TscConfig, RuffConfig, OxlintConfig } from '../core/types';
import { SETTINGS_SECTION } from '../core/constants';
import { DEFAULT_IGNORE_PATTERNS } from '../core/constants';

/** Abstraction over `workspace.getConfiguration` and config change events for testability */
export interface ConfigDelegate {
  getConfiguration(section?: string): {
    get<T>(key: string, defaultValue?: T): T;
  };
  onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
}

const defaultDelegate: ConfigDelegate = {
  getConfiguration: (section) => workspace.getConfiguration(section),
  onDidChangeConfiguration: workspace.onDidChangeConfiguration,
};

/** Reads and watches `problemExplorer.*` settings, firing `onDidChangeConfig` on relevant changes */
export class ConfigManager implements Disposable {
  private delegate: ConfigDelegate;
  private config: Config;
  private readonly _onDidChangeConfig = new EventEmitter<void>();
  /** Fires when any `problemExplorer.*` setting changes */
  readonly onDidChangeConfig: Event<void> = this._onDidChangeConfig.event;
  private readonly disposable: Disposable;

  constructor(delegate?: ConfigDelegate) {
    this.delegate = delegate ?? defaultDelegate;
    this.config = this.readConfig();
    this.disposable = this.delegate.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SETTINGS_SECTION)) {
        this.config = this.readConfig();
        this._onDidChangeConfig.fire();
      }
    });
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChangeConfig.dispose();
  }

  /** Get the current snapshot of all `problemExplorer.*` settings */
  getConfig(): Config {
    return this.config;
  }

private readConfig(): Config {
    const cfg = this.delegate.getConfiguration(SETTINGS_SECTION);
    return {
      enabled: cfg.get<boolean>('enabled', true),
      showWarnings: cfg.get<boolean>('showWarnings', true),
      badgeStyle: cfg.get<'letter' | 'count' | 'dot' | 'none'>('badgeStyle', 'count'),
      ignorePatterns: cfg.get<string[]>('ignorePatterns', [...DEFAULT_IGNORE_PATTERNS]),
      errorColor: cfg.get<string | undefined>('errorColor', undefined),
      warningColor: cfg.get<string | undefined>('warningColor', undefined),
      infoColor: cfg.get<string | undefined>('infoColor', undefined),
      severityOverrides: cfg.get<Record<string, Record<string, string>> | undefined>('severityOverrides', undefined),
      autoScanEnabled: cfg.get<boolean>('autoScan.enabled', false),
      autoScanDelay: cfg.get<number>('autoScanDelay', 800),
      debug: cfg.get<boolean>('debug', false),
      reconcileIntervalMs: cfg.get<number>('reconcileIntervalMs', 30000),
      typescript: this.readTscConfig(cfg),
      eslint: this.readEslintConfig(cfg),
      ruff: this.readRuffConfig(cfg),
      oxlint: this.readOxlintConfig(cfg),
    };
  }

  private readTscConfig(cfg: { get<T>(key: string, defaultValue?: T): T }): TscConfig {
    return {
      enabled: cfg.get<boolean>('typescript.enabled', true),
      autoScan: cfg.get<boolean>('typescript.autoScan', false),
      scanOnStartup: cfg.get<boolean>('typescript.scanOnStartup', true),
      timeout: cfg.get<number>('typescript.timeout', 120000),
      useWorkspaceVersion: cfg.get<boolean>('typescript.useWorkspaceVersion', true),
      maxConcurrentScans: cfg.get<number>('typescript.maxConcurrentScans', 1),
    };
  }

  private readEslintConfig(cfg: { get<T>(key: string, defaultValue?: T): T }): EslintConfig {
    return {
      enabled: cfg.get<boolean>('eslint.enabled', true),
      autoScan: cfg.get<boolean>('eslint.autoScan', false),
      scanOnStartup: cfg.get<boolean>('eslint.scanOnStartup', true),
      timeout: cfg.get<number>('eslint.timeout', 120000),
      maxConcurrentScans: cfg.get<number>('eslint.maxConcurrentScans', 2),
      eslintPath: cfg.get<string | undefined>('eslint.eslintPath', undefined),
    };
  }

  private readRuffConfig(cfg: { get<T>(key: string, defaultValue?: T): T }): RuffConfig {
    return {
      enabled: cfg.get<boolean>('ruff.enabled', true),
      autoScan: cfg.get<boolean>('ruff.autoScan', false),
      scanOnStartup: cfg.get<boolean>('ruff.scanOnStartup', true),
      timeout: cfg.get<number>('ruff.timeout', 120000),
      maxConcurrentScans: cfg.get<number>('ruff.maxConcurrentScans', 2),
    };
  }

  private readOxlintConfig(cfg: { get<T>(key: string, defaultValue?: T): T }): OxlintConfig {
    return {
      enabled: cfg.get<boolean>('oxlint.enabled', true),
      autoScan: cfg.get<boolean>('oxlint.autoScan', false),
      scanOnStartup: cfg.get<boolean>('oxlint.scanOnStartup', true),
      timeout: cfg.get<number>('oxlint.timeout', 120000),
      maxConcurrentScans: cfg.get<number>('oxlint.maxConcurrentScans', 2),
    };
  }
}
