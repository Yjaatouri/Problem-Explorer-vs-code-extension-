import {
  ConfigurationChangeEvent,
  Disposable,
  Event,
  EventEmitter,
  workspace,
} from 'vscode';
import { Config } from '../core/types';
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
      badgeStyle: cfg.get<'letter' | 'count' | 'dot' | 'none'>('badgeStyle', 'letter'),
      ignorePatterns: cfg.get<string[]>('ignorePatterns', [...DEFAULT_IGNORE_PATTERNS]),
      errorColor: cfg.get<string | undefined>('errorColor', undefined),
      warningColor: cfg.get<string | undefined>('warningColor', undefined),
      infoColor: cfg.get<string | undefined>('infoColor', undefined),
      severityOverrides: cfg.get<Record<string, Record<string, string>> | undefined>('severityOverrides', undefined),
    };
  }
}
