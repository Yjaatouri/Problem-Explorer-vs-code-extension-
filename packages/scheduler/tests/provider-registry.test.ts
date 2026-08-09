import { ProviderHealth, SchedulerError } from '@pe/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/index.js';
import { makeProvider, waitFor } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProviderRegistry', () => {
  it('registers and auto-checks health (Unknown → Ready)', async () => {
    const registry = new ProviderRegistry();
    const { provider } = makeProvider({ id: 'tsc' });
    registry.register(provider);
    expect(registry.getById('tsc')).toBe(provider);
    expect(registry.getStatus('tsc')?.health).toBe(ProviderHealth.Unknown);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    expect(registry.getStatus('tsc')?.lastCheckMs).toBeGreaterThan(0);
    registry.dispose();
  });

  it('rejects duplicate registration with a stable error code', () => {
    const registry = new ProviderRegistry();
    const { provider } = makeProvider({ id: 'tsc' });
    registry.register(provider);
    let caught: unknown;
    try {
      registry.register(provider);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchedulerError);
    expect((caught as SchedulerError).code).toBe('duplicate-provider');
    registry.dispose();
  });

  it('sorts getByCapability by confidence tier descending', async () => {
    const registry = new ProviderRegistry();
    const realtime = makeProvider({
      id: 'realtime-ts',
      capabilities: { confidenceTier: 2 },
    });
    const scanner = makeProvider({ id: 'tsc' }); // tier 3 (default)
    registry.register(realtime.provider);
    registry.register(scanner.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    const forTypescript = registry.getByCapability('typescript');
    expect(forTypescript.map((p) => p.id)).toEqual(['tsc', 'realtime-ts']);
    registry.dispose();
  });

  it('getByCapability excludes providers that do not declare the capability', () => {
    const registry = new ProviderRegistry();
    const python = makeProvider({
      id: 'ruff',
      capabilities: { supportedConfigTypes: ['python'] },
    });
    registry.register(python.provider);
    expect(registry.getByCapability('python')).toHaveLength(1);
    expect(registry.getByCapability('typescript')).toHaveLength(0);
    registry.dispose();
  });

  it('healthCheckAll is isolated: one failing provider never breaks the rest', async () => {
    const registry = new ProviderRegistry();
    const bad = makeProvider({ id: 'bad' });
    bad.provider.healthCheck = async () => {
      throw new Error('check crashed');
    };
    const good = makeProvider({ id: 'good' });
    registry.register(bad.provider);
    registry.register(good.provider);
    await expect(registry.healthCheckAll()).resolves.toBeDefined();
    expect(registry.getStatus('bad')?.health).toBe(ProviderHealth.Failed);
    expect(registry.getStatus('good')?.health).toBe(ProviderHealth.Ready);
    registry.dispose();
  });

  it('a healthCheck that throws yields Failed, not a crash', async () => {
    const registry = new ProviderRegistry();
    const throwing = makeProvider({ id: 'throwing' });
    throwing.provider.healthCheck = async () => {
      throw new Error('check crashed');
    };
    registry.register(throwing.provider);
    await waitFor(() => registry.getStatus('throwing')?.health === ProviderHealth.Failed);
    registry.dispose();
  });

  it('emits onStatusChanged only on health transitions', async () => {
    const registry = new ProviderRegistry();
    const events: string[] = [];
    registry.onStatusChanged((event) => events.push(event.status.health));
    const { provider } = makeProvider({ id: 'tsc' });
    registry.register(provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    registry.finishScan('tsc', true); // Ready → Ready: no event
    expect(events.filter((health) => health === 'ready').length).toBe(1);
    registry.dispose();
  });

  it('markScanning is transient and never emitted', async () => {
    const registry = new ProviderRegistry();
    const events: string[] = [];
    registry.onStatusChanged((event) => events.push(event.status.health));
    const { provider } = makeProvider({ id: 'tsc' });
    registry.register(provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    registry.markScanning('tsc');
    expect(registry.getStatus('tsc')?.health).toBe(ProviderHealth.Scanning);
    expect(events).not.toContain('scanning');
    registry.finishScan('tsc', true);
    registry.dispose();
  });

  it('finishScan(false) moves the provider to Failed and emits', async () => {
    const registry = new ProviderRegistry();
    const events: string[] = [];
    registry.onStatusChanged((event) => events.push(event.status.health));
    const { provider } = makeProvider({ id: 'tsc' });
    registry.register(provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    registry.finishScan('tsc', false, new Error('timeout'));
    expect(registry.getStatus('tsc')?.health).toBe(ProviderHealth.Failed);
    expect(events).toContain('failed');
    registry.dispose();
  });

  it('re-checks a MissingDependency provider on the retry timer', async () => {
    let healthy = false;
    const registry = new ProviderRegistry({ healthCheckRetryMs: 40 });
    const { provider } = makeProvider({
      id: 'tool',
      health: ProviderHealth.MissingDependency,
    });
    provider.healthCheck = async () =>
      healthy ? { health: ProviderHealth.Ready } : { health: ProviderHealth.MissingDependency };
    registry.register(provider);
    await waitFor(() => registry.getStatus('tool')?.health === ProviderHealth.MissingDependency);
    healthy = true;
    await waitFor(() => registry.getStatus('tool')?.health === ProviderHealth.Ready);
    registry.dispose();
  });

  it('registerFromManifest loads metadata and health-checks the command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-manifest-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        id: 'fake-tool',
        displayName: 'Fake Tool',
        capabilities: {
          confidenceTier: 3,
          supportedConfigTypes: ['typescript'],
          workspaceScan: true,
          incrementalScan: true,
          realtime: false,
          extensions: ['.ts'],
          cost: 'medium',
        },
        configSchema: { type: 'object' },
        defaultConfig: { enabled: true },
        healthCheckCommand: ['node', '-e', 'process.exit(0)'],
      }),
      'utf8',
    );
    const registry = new ProviderRegistry();
    const loaded = registry.registerFromManifest(manifestPath);
    expect(loaded.id).toBe('fake-tool');
    await waitFor(() => registry.getStatus('fake-tool')?.health === ProviderHealth.Ready);
    registry.dispose();
  });

  it('registerFromManifest rejects invalid manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-manifest-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'bad.json');
    writeFileSync(manifestPath, '{"id": "x"}', 'utf8');
    const registry = new ProviderRegistry();
    let caught: unknown;
    try {
      registry.registerFromManifest(manifestPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchedulerError);
    expect((caught as SchedulerError).code).toBe('manifest-invalid');
    try {
      registry.registerFromManifest(join(dir, 'missing.json'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchedulerError);
    expect((caught as SchedulerError).code).toBe('manifest-unreadable');
    registry.dispose();
  });
});
