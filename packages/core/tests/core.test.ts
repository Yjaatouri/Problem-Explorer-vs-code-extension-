import { describe, it, expect } from 'vitest';
import type { Uri } from '../src/types/index.js';
import { normalizeUriKey, getParentKey, clearUriKeyCache, LRUCache } from '../src/uri/index.js';
import { validateConfig, mergeWithDefaults, validateProviderConfig } from '../src/config/index.js';
import { TypedEventEmitter, createEvent, type Event } from '../src/events/index.js';
import {
  ConfigError,
  ProviderError,
  ScanError,
  HealthCheckError,
  EngineError,
  ok,
  err,
  type Result,
} from '../src/errors/index.js';
import {
  ProblemSeverity,
  ConfidenceTier,
  ScanType,
  ProviderHealth,
  ZERO_PROBLEM_STATE,
  type Cost,
  type ScanPlan,
  type ScanPriority,
} from '../src/types/index.js';

/** Minimal Uri-shaped object for tests (structural match, no vscode) */
function uri(s: string): Uri {
  const m = /^file:\/\/\/([^/]*)(\/.*)$/.exec(s.replace(/^file:\/\//, 'file:///'));
  const authority = m?.[1] ?? '';
  const path = m?.[2] ?? s;
  return {
    scheme: 'file',
    authority,
    path,
    get fsPath() {
      return this.path;
    },
    toString: () => s,
    with: () => uri(s),
  } as Uri;
}

describe('core package', () => {
  describe('uri utilities', () => {
    it('normalizes Windows drive letter casing', () => {
      clearUriKeyCache();
      expect(normalizeUriKey(uri('file:///C%3A/Users/test/file.ts'))).toBe(
        'file:///c%3A/Users/test/file.ts',
      );
      expect(normalizeUriKey(uri('file:///C:/Users/test/file.ts'))).toBe(
        'file:///c%3A/Users/test/file.ts',
      );
      expect(normalizeUriKey(uri('file:///D%3A/project/src/file.ts'))).toBe(
        'file:///d%3A/project/src/file.ts',
      );
    });

    it('strips trailing slashes but never the scheme root', () => {
      expect(normalizeUriKey(uri('file:///home/user/file.ts/'))).toBe('file:///home/user/file.ts');
      expect(normalizeUriKey(uri('file:///'))).toBe('file:///');
    });

    it('equivalent URIs map to the same key', () => {
      clearUriKeyCache();
      const a = normalizeUriKey(uri('file:///C%3A/x/'));
      const b = normalizeUriKey(uri('file:///c%3A/x'));
      expect(a).toBe(b);
    });

    it('gets parent key correctly', () => {
      clearUriKeyCache();
      expect(getParentKey('file:///c%3A/project/src/file.ts')).toBe('file:///c%3A/project/src');
      expect(getParentKey('file:///c%3A/project/src')).toBe('file:///c%3A/project');
      expect(getParentKey('file:///c%3A')).toBe('file:///c%3A'); // above root — stays
    });

    it('clears cache', () => {
      clearUriKeyCache();
      expect(() => clearUriKeyCache()).not.toThrow();
    });

    it('LRU cache evicts least recently used entries', () => {
      const cache = new LRUCache<string, number>(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // 'a' is now most recent
      cache.set('c', 3); // evicts 'b'
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe(1);
      expect(cache.get('c')).toBe(3);
      expect(cache.size).toBe(2);
    });
  });

  describe('config validation', () => {
    interface TestConfig {
      enabled: boolean;
      timeout: number;
    }

    const schema = {
      $id: 'test-provider',
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: true },
        timeout: { type: 'number', default: 30_000 },
      },
    };

    it('passes valid config through', () => {
      const result = validateConfig<TestConfig>({ enabled: false }, schema);
      expect(result.enabled).toBe(false);
    });

    it('throws ConfigError on invalid config', () => {
      expect(() => validateConfig<TestConfig>({ enabled: 'yes' }, schema)).toThrow(ConfigError);
      expect(() =>
        validateConfig({ unknown: 1 }, { type: 'object', additionalProperties: false }),
      ).toThrow(ConfigError);
    });

    it('merges with defaults, user values win', () => {
      const result = mergeWithDefaults<TestConfig>({ timeout: 60_000 }, schema);
      expect(result.enabled).toBe(true);
      expect(result.timeout).toBe(60_000);
    });

    it('mergeWithDefaults ignores explicit undefined', () => {
      const result = mergeWithDefaults<TestConfig>({ enabled: undefined }, schema);
      expect(result.enabled).toBe(true);
    });

    it('validateProviderConfig merges then validates', () => {
      const result = validateProviderConfig<TestConfig>({}, schema);
      expect(result.enabled).toBe(true);
      expect(result.timeout).toBe(30_000);
    });
  });

  describe('events', () => {
    it('fires and disposes', () => {
      const emitter = new TypedEventEmitter<string>();
      const received: string[] = [];
      const sub = emitter.on((data) => received.push(data));
      emitter.fire('a');
      sub.dispose();
      emitter.fire('b');
      expect(received).toEqual(['a']);
      expect(emitter.listenerCount).toBe(0);
    });

    it('once fires a single time', () => {
      const emitter = new TypedEventEmitter<number>();
      const received: number[] = [];
      emitter.once((n) => received.push(n));
      emitter.fire(1);
      emitter.fire(2);
      expect(received).toEqual([1]);
    });

    it('a throwing handler does not break other handlers', () => {
      const emitter = new TypedEventEmitter<number>();
      const received: number[] = [];
      emitter.on(() => {
        throw new Error('boom');
      });
      emitter.on((n) => received.push(n));
      emitter.fire(1);
      expect(received).toEqual([1]);
    });

    it('createEvent returns Event + fire', () => {
      const { event, fire } = createEvent<number>();
      const received: number[] = [];
      const sub: { dispose(): void } = event((n) => received.push(n));
      fire(1);
      fire(2);
      sub.dispose();
      fire(3);
      expect(received).toEqual([1, 2]);
    });

    it('Event type is callable like a property (VS Code style)', () => {
      const { event } = createEvent<number>();
      const e: Event<number> = event;
      expect(typeof e).toBe('function');
    });

    it('clear removes all handlers', () => {
      const emitter = new TypedEventEmitter<string>();
      emitter.on(() => undefined);
      emitter.on(() => undefined);
      expect(emitter.listenerCount).toBe(2);
      emitter.clear();
      expect(emitter.listenerCount).toBe(0);
    });
  });

  describe('errors', () => {
    it('creates ConfigError with stable code', () => {
      const error = new ConfigError('bad config', { field: 'enabled' });
      expect(error).toBeInstanceOf(EngineError);
      expect(error.name).toBe('ConfigError');
      expect(error.code).toBe('CONFIG_ERROR');
      expect(error.context).toEqual({ field: 'enabled' });
    });

    it('creates ProviderError with providerId', () => {
      const error = new ProviderError('not found', 'tsc', 'NOT_FOUND', { path: '/src' });
      expect(error.providerId).toBe('tsc');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.context).toMatchObject({ providerId: 'tsc', path: '/src' });
    });

    it('creates ScanError with uri', () => {
      const error = new ScanError('failed', 'eslint', 'file:///a.ts', 'SCAN_FAILED');
      expect(error.uri).toBe('file:///a.ts');
      expect(error.providerId).toBe('eslint');
    });

    it('creates HealthCheckError', () => {
      const error = new HealthCheckError('binary missing', 'ruff');
      expect(error.code).toBe('HEALTH_CHECK_FAILED');
      expect(error.providerId).toBe('ruff');
    });

    it('Result helpers work with narrowing', () => {
      const success: Result<number> = ok(42);
      expect(success.success).toBe(true);
      if (success.success) {
        expect(success.value).toBe(42);
      }

      const failure: Result<number> = err(new ConfigError('bad'));
      expect(failure.success).toBe(false);
      if (!failure.success) {
        expect(failure.error.code).toBe('CONFIG_ERROR');
      }
    });
  });

  describe('types', () => {
    it('ProblemSeverity ordering', () => {
      expect(ProblemSeverity.None).toBeLessThan(ProblemSeverity.Info);
      expect(ProblemSeverity.Info).toBeLessThan(ProblemSeverity.Warning);
      expect(ProblemSeverity.Warning).toBeLessThan(ProblemSeverity.Error);
    });

    it('ConfidenceTier ordering', () => {
      expect(ConfidenceTier.WorkspaceScanner).toBe(3);
      expect(ConfidenceTier.Realtime).toBe(2);
      expect(ConfidenceTier.Fallback).toBe(1);
    });

    it('ScanType values', () => {
      expect(ScanType.Startup).toBe('startup');
      expect(ScanType.Save).toBe('save');
      expect(ScanType.Manual).toBe('manual');
      expect(ScanType.Periodic).toBe('periodic');
    });

    it('ProviderHealth values', () => {
      const all = Object.values(ProviderHealth);
      expect(all).toHaveLength(7);
      expect(all).toContain('missing_dependency');
      expect(all).toContain('unknown'); // initial state before first check (§11.1)
    });

    it('Cost union values', () => {
      const costs: Cost[] = ['cheap', 'medium', 'expensive'];
      expect(costs).toHaveLength(3);
    });

    it('ScanPlan carries capability + scope + priority', () => {
      const plan: ScanPlan = {
        capability: 'typescript',
        scope: 'file',
        uris: [uri('file:///src/a.ts')],
        priority: 'save',
      };
      expect(plan.scope).toBe('file');
      const priority: ScanPriority = plan.priority;
      expect(priority).toBe('save');
    });

    it('ZERO_PROBLEM_STATE is frozen zero state', () => {
      expect(ZERO_PROBLEM_STATE.severity).toBe(ProblemSeverity.None);
      expect(ZERO_PROBLEM_STATE.errorCount).toBe(0);
      expect(ZERO_PROBLEM_STATE.fileCount).toBe(0);
    });
  });
});
