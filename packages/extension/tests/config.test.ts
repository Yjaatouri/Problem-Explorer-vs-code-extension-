import { describe, expect, it } from 'vitest';

import { readConfig, toEngineConfig, providerList } from '../src/config.js';
import type { SettingsReader } from '../src/config.js';

function reader(values: Record<string, unknown>): SettingsReader {
  return {
    get: <T>(key: string, fallback: T): T => {
      const value = values[key];
      return (value === undefined ? fallback : value) as T;
    },
  };
}

describe('readConfig', () => {
  it('applies defaults for missing keys', () => {
    const config = readConfig(reader({}));
    expect(config.enabled).toBe(true);
    expect(config.badgeStyle).toBe('letter');
    expect(config.autoScanDelay).toBe(2000);
    expect(config.typescript.scanOnStartup).toBe(true);
    expect(config.eslint.scanOnStartup).toBe(false);
    expect(config.ruff.scanOnStartup).toBe(false);
    expect(config.ruff.enabled).toBe(true);
    expect(config.ruff.timeout).toBe(120_000);
    expect(config.ruff.extraArgs).toEqual([]);
    expect(config.ignorePatterns).toContain('**/node_modules/**');
  });

  it('reads explicit values', () => {
    const config = readConfig(
      reader({
        'typescript.enabled': false,
        'autoScanDelay': 1500,
        'badgeStyle': 'count',
        'ruff.enabled': false,
        'ruff.timeout': 90_000,
        'ruff.extraArgs': ['--select', 'F821'],
      }),
    );
    expect(config.typescript.enabled).toBe(false);
    expect(config.autoScanDelay).toBe(1500);
    expect(config.badgeStyle).toBe('count');
    expect(config.ruff.enabled).toBe(false);
    expect(config.ruff.timeout).toBe(90_000);
    expect(config.ruff.extraArgs).toEqual(['--select', 'F821']);
  });
});

describe('toEngineConfig', () => {
  it('maps the extension tuning knobs', () => {
    const config = readConfig(reader({}));
    const engine = toEngineConfig(config);
    expect(engine.debounceMs).toBe(2000);
    expect(engine.scanTimeoutMs).toBe(120_000);
    expect(engine.maxConcurrency?.['expensive']).toBe(1);
  });

  it('scan timeout follows the largest provider timeout', () => {
    const config = readConfig(
      reader({
        'typescript.timeout': 90_000,
        'eslint.timeout': 30_000,
        'ruff.timeout': 30_000,
      }),
    );
    expect(toEngineConfig(config).scanTimeoutMs).toBe(90_000);
  });

  it('ruff timeout participates in the scan timeout', () => {
    const config = readConfig(
      reader({
        'typescript.timeout': 30_000,
        'eslint.timeout': 30_000,
        'ruff.timeout': 75_000,
      }),
    );
    expect(toEngineConfig(config).scanTimeoutMs).toBe(75_000);
  });
});

describe('providerList', () => {
  it('vscode realtime is always first', () => {
    const config = readConfig(reader({}));
    expect(providerList(config)[0]).toBe('vscode');
    expect(providerList(config)).toContain('tsc');
    expect(providerList(config)).toContain('eslint');
    expect(providerList(config)).toContain('ruff');
  });

  it('disabled providers are excluded', () => {
    const config = readConfig(
      reader({
        'typescript.enabled': false,
        'eslint.enabled': false,
        'ruff.enabled': false,
      }),
    );
    expect(providerList(config)).toEqual(['vscode']);
  });

  it('ruff disabled removes ruff but keeps the rest', () => {
    const config = readConfig(reader({ 'ruff.enabled': false }));
    expect(providerList(config)).toEqual(['vscode', 'tsc', 'eslint']);
  });
});