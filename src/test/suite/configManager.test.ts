import * as assert from 'assert';
import { ConfigManager, ConfigDelegate } from '../../config/configManager';
import { DEFAULT_IGNORE_PATTERNS } from '../../core/constants';

suite('ConfigManager', () => {
  function makeMockDelegate(
    overrides?: Record<string, unknown>,
  ): { delegate: ConfigDelegate; fireChange: () => void } {
    const values: Record<string, unknown> = {
      enabled: true,
      showWarnings: true,
      badgeStyle: 'letter',
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
      errorColor: undefined,
      warningColor: undefined,
      infoColor: undefined,
      ...overrides,
    };
    type Listener = (e: { affectsConfiguration(s: string): boolean }) => void;
    const listeners: Listener[] = [];

    return {
      delegate: {
        getConfiguration: () => ({
          get: <T>(key: string, defaultValue?: T): T =>
            (values[key] as T) ?? (defaultValue as T),
        }),
        onDidChangeConfiguration: (listener) => {
          listeners.push(listener);
          return { dispose: () => {} };
        },
      } as unknown as ConfigDelegate,
      fireChange: () => {
        const e = { affectsConfiguration: (s: string) => s === 'problemExplorer' };
        for (const l of listeners) {
          l(e as any);
        }
      },
    };
  }

  test('reads default config when no overrides', () => {
    const { delegate } = makeMockDelegate();
    const cm = new ConfigManager(delegate);
    const config = cm.getConfig();
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.showWarnings, true);
    assert.strictEqual(config.badgeStyle, 'letter');
    assert.deepStrictEqual(config.ignorePatterns, [...DEFAULT_IGNORE_PATTERNS]);
    assert.strictEqual(config.errorColor, undefined);
    assert.strictEqual(config.warningColor, undefined);
    assert.strictEqual(config.infoColor, undefined);
  });

  test('reads overridden values', () => {
    const { delegate } = makeMockDelegate({
      enabled: false,
      showWarnings: false,
      badgeStyle: 'dot',
      ignorePatterns: ['**/node_modules/**'],
      errorColor: '#ff0000',
    });
    const cm = new ConfigManager(delegate);
    const config = cm.getConfig();
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.showWarnings, false);
    assert.strictEqual(config.badgeStyle, 'dot');
    assert.deepStrictEqual(config.ignorePatterns, ['**/node_modules/**']);
    assert.strictEqual(config.errorColor, '#ff0000');
  });

  test('badgeStyle enum values are accepted', () => {
    for (const style of ['letter', 'count', 'dot', 'none'] as const) {
      const { delegate } = makeMockDelegate({ badgeStyle: style });
      const cm = new ConfigManager(delegate);
      assert.strictEqual(cm.getConfig().badgeStyle, style);
    }
  });

  test('fires onDidChangeConfig on relevant config change', () => {
    const { delegate, fireChange } = makeMockDelegate();
    const cm = new ConfigManager(delegate);
    let fired = false;
    cm.onDidChangeConfig(() => {
      fired = true;
    });
    fireChange();
    assert.strictEqual(fired, true);
  });

  test('does not fire onDidChangeConfig for unrelated config changes', () => {
    const values: Record<string, unknown> = {
      enabled: true,
      showWarnings: true,
      badgeStyle: 'letter',
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
      errorColor: undefined,
      warningColor: undefined,
      infoColor: undefined,
    };
    type Listener = (e: { affectsConfiguration(s: string): boolean }) => void;
    const listeners: Listener[] = [];
    const delegate: ConfigDelegate = {
      getConfiguration: () => ({
        get: <T>(key: string, d?: T): T => (values[key] as T) ?? (d as T),
      }),
      onDidChangeConfiguration: (l) => {
        listeners.push(l);
        return { dispose: () => {} };
      },
    } as unknown as ConfigDelegate;
    const cm = new ConfigManager(delegate);
    let fired = false;
    cm.onDidChangeConfig(() => {
      fired = true;
    });

    const otherSection = {
      affectsConfiguration: (s: string) => s === 'otherSection',
    };
    for (const l of listeners) {
      l(otherSection as any);
    }
    assert.strictEqual(fired, false);
  });

  test('updates config after change event', () => {
    const values: Record<string, unknown> = {
      enabled: true,
      showWarnings: true,
      badgeStyle: 'letter',
      ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
      errorColor: undefined,
      warningColor: undefined,
      infoColor: undefined,
    };
    type Listener = (e: { affectsConfiguration(s: string): boolean }) => void;
    const listeners: Listener[] = [];
    const delegate: ConfigDelegate = {
      getConfiguration: () => ({
        get: <T>(key: string, d?: T): T => (values[key] as T) ?? (d as T),
      }),
      onDidChangeConfiguration: (l) => {
        listeners.push(l);
        return { dispose: () => {} };
      },
    } as unknown as ConfigDelegate;
    const cm = new ConfigManager(delegate);
    assert.strictEqual(cm.getConfig().enabled, true);

    values.enabled = false;
    const e = { affectsConfiguration: (s: string) => s === 'problemExplorer' };
    for (const l of listeners) {
      l(e as any);
    }
    assert.strictEqual(cm.getConfig().enabled, false);
  });
});
