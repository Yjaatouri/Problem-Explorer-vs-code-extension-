import { ProviderHealth, ScanType } from '@pe/core';
import type { ConfigType, ScanPlan } from '@pe/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, ScanScheduler } from '../src/index.js';
import { deferred, makeProvider, testUri, waitFor } from './helpers.js';

function plan(overrides: Partial<ScanPlan> = {}): ScanPlan {
  return {
    capability: 'typescript',
    scope: 'file',
    uris: [testUri('C:/proj/src/a.ts')],
    priority: 'save',
    ...overrides,
  };
}

function setup(registry: ProviderRegistry) {
  return new ScanScheduler({ registry, idleWindowMs: 50 });
}

describe('ScanScheduler', () => {
  it('dispatches by capability, never by provider id', async () => {
    const registry = new ProviderRegistry();
    const tsc = makeProvider({ id: 'tsc' });
    const ruff = makeProvider({
      id: 'ruff',
      capabilities: { supportedConfigTypes: ['python'] },
    });
    registry.register(tsc.provider);
    registry.register(ruff.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);

    scheduler.enqueue(plan());
    await waitFor(() => tsc.calls.length === 1);
    await waitFor(() => scheduler.runningCount === 0);
    expect(ruff.calls).toHaveLength(0); // python provider never woke

    scheduler.enqueue(plan({ capability: 'python' }));
    await waitFor(() => ruff.calls.length === 1);
    scheduler.dispose();
    registry.dispose();
  });

  it('picks the highest-tier Ready provider for a capability', async () => {
    const registry = new ProviderRegistry();
    const realtime = makeProvider({
      id: 'realtime-ts',
      capabilities: { confidenceTier: 2 },
    });
    const scanner = makeProvider({ id: 'scanner-ts' }); // tier 3
    registry.register(realtime.provider);
    registry.register(scanner.provider);
    await waitFor(() => registry.getStatus('scanner-ts')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    scheduler.enqueue(plan());
    await waitFor(() => scheduler.runningCount === 0);
    expect(scanner.calls).toHaveLength(1);
    expect(realtime.calls).toHaveLength(0);
    scheduler.dispose();
    registry.dispose();
  });

  it('falls back to a lower-tier Ready provider when the scanner is unhealthy', async () => {
    const registry = new ProviderRegistry();
    const realtime = makeProvider({
      id: 'realtime-ts',
      capabilities: { confidenceTier: 2 },
    });
    const scanner = makeProvider({
      id: 'scanner-ts',
      health: ProviderHealth.Misconfigured,
    });
    registry.register(scanner.provider);
    registry.register(realtime.provider);
    await waitFor(() => registry.getStatus('realtime-ts')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    scheduler.enqueue(plan());
    await waitFor(() => scheduler.runningCount === 0);
    expect(realtime.calls).toHaveLength(1);
    expect(scanner.calls).toHaveLength(0);
    scheduler.dispose();
    registry.dispose();
  });

  it('respects concurrency slots per cost class (medium: 2)', async () => {
    const registry = new ProviderRegistry();
    const g1 = deferred<void>();
    const g2 = deferred<void>();
    const g3 = deferred<void>();
    const one = makeProvider({ id: 'one', gate: g1 }); // typescript
    const two = makeProvider({
      id: 'two',
      capabilities: { supportedConfigTypes: ['javascript'] },
      gate: g2,
    });
    const three = makeProvider({
      id: 'three',
      capabilities: { supportedConfigTypes: ['python'] },
      gate: g3,
    });
    registry.register(one.provider);
    registry.register(two.provider);
    registry.register(three.provider);
    await waitFor(() => registry.getStatus('three')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/a.ts')] }));
    scheduler.enqueue(plan({ capability: 'javascript', uris: [testUri('C:/proj/b.js')] }));
    scheduler.enqueue(plan({ capability: 'python', uris: [testUri('C:/proj/c.py')] }));
    await waitFor(() => scheduler.runningCount === 2);
    expect(scheduler.queuedCount).toBe(1);
    g1.resolve();
    await waitFor(() => scheduler.runningCount === 2); // third job took the free slot
    g2.resolve();
    await waitFor(() => scheduler.runningCount === 1);
    g3.resolve();
    await waitFor(() => scheduler.runningCount === 0);
    expect(one.calls).toHaveLength(1);
    expect(two.calls).toHaveLength(1);
    expect(three.calls).toHaveLength(1);
    scheduler.dispose();
    registry.dispose();
  });

  it('cheap class gets 4 slots, expensive gets 1', async () => {
    const registry = new ProviderRegistry();
    const capabilities: Array<[ConfigType, string]> = [
      ['typescript', 'c0'],
      ['javascript', 'c1'],
      ['python', 'c2'],
      ['rust', 'c3'],
      ['go', 'c4'],
    ];
    const gates = capabilities.map(() => deferred<void>());
    const cheap = capabilities.map(([capability, id], i) =>
      makeProvider({
        id,
        capabilities: { cost: 'cheap', supportedConfigTypes: [capability] },
        gate: gates[i],
      }),
    );
    for (const { provider } of cheap) {
      registry.register(provider);
    }
    await waitFor(() => registry.getStatus('c4')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    for (const [capability, id] of capabilities) {
      scheduler.enqueue(plan({ capability, uris: [testUri(`C:/proj/${id}.x`)] }));
    }
    await waitFor(() => scheduler.runningCount === 4);
    expect(scheduler.queuedCount).toBe(1);
    for (const gate of gates) {
      gate.resolve();
    }
    await waitFor(() => scheduler.runningCount === 0);

    const expensiveGates = [deferred<void>(), deferred<void>()];
    const expensive = expensiveGates.map((gate, i) =>
      makeProvider({
        id: `expensive-${i}`,
        capabilities: { cost: 'expensive', supportedConfigTypes: [i === 0 ? 'csharp' : 'java'] },
        gate,
      }),
    );
    for (const { provider } of expensive) {
      registry.register(provider);
    }
    await waitFor(() => registry.getStatus('expensive-1')?.health === ProviderHealth.Ready);
    scheduler.enqueue(plan({ capability: 'csharp', uris: [testUri('C:/proj/x.cs')] }));
    scheduler.enqueue(plan({ capability: 'java', uris: [testUri('C:/proj/x.java')] }));
    await waitFor(() => scheduler.runningCount === 1);
    expect(scheduler.queuedCount).toBe(1);
    for (const gate of expensiveGates) {
      gate.resolve();
    }
    await waitFor(() => scheduler.runningCount === 0);
    scheduler.dispose();
    registry.dispose();
  });

  it('merges queued jobs by capability + scope (no duplicate work)', async () => {
    const registry = new ProviderRegistry();
    const gate = deferred<void>();
    const tsc = makeProvider({ id: 'tsc', gate });
    registry.register(tsc.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    // First job occupies the only medium slot; the next two arrive while it runs.
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/a.ts')] }));
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/b.ts')] }));
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/c.ts')] }));
    await waitFor(() => tsc.calls.length === 1);
    expect(scheduler.queuedCount).toBe(1); // b and c merged into one queued job
    gate.resolve();
    await waitFor(() => scheduler.runningCount === 0);
    expect(tsc.calls).toHaveLength(2);
    const uris = tsc.calls[1]?.uris?.map((uri) => uri.fsPath) ?? [];
    expect(uris.sort()).toEqual(['C:/proj/b.ts', 'C:/proj/c.ts'].sort());
    scheduler.dispose();
    registry.dispose();
  });

  it('drops queued file jobs when a workspace rescan covers them', async () => {
    const registry = new ProviderRegistry();
    const flaky = makeProvider({ id: 'tsc' });
    flaky.provider.healthCheck = async () => ({ health: ProviderHealth.Failed });
    registry.register(flaky.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Failed);
    const scheduler = setup(registry);
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/a.ts')] })); // stays queued
    scheduler.enqueue(plan({ scope: 'workspace', uris: [testUri('C:/proj')] }));
    expect(scheduler.snapshot()).toHaveLength(1);
    expect(scheduler.snapshot()[0]?.scope).toBe('workspace');
    scheduler.dispose();
    registry.dispose();
  });

  it('does not let a job for an unhealthy provider stall other capabilities', async () => {
    const registry = new ProviderRegistry();
    const broken = makeProvider({ id: 'broken-ts', health: ProviderHealth.Failed });
    const working = makeProvider({
      id: 'working-py',
      capabilities: { supportedConfigTypes: ['python'] },
    });
    registry.register(broken.provider);
    registry.register(working.provider);
    await waitFor(() => registry.getStatus('working-py')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    // Head of the queue: typescript has only an unhealthy provider.
    scheduler.enqueue(plan());
    scheduler.enqueue(plan({ capability: 'python' }));
    await waitFor(() => working.calls.length === 1);
    expect(broken.calls).toHaveLength(0);
    expect(scheduler.queuedCount).toBe(1); // broken job waits, does not block
    scheduler.dispose();
    registry.dispose();
  });

  it('overflows the bounded queue with an event, never an unbounded queue', async () => {
    const registry = new ProviderRegistry();
    const gate = deferred<void>();
    const tsc = makeProvider({
      id: 'tsc',
      gate,
      capabilities: { supportedConfigTypes: ['typescript', 'python', 'rust'] },
    });
    registry.register(tsc.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    const scheduler = new ScanScheduler({ registry, queueSize: 2, idleWindowMs: 50 });
    const overflowed: string[] = [];
    scheduler.onQueueOverflow((event) => overflowed.push(event.job.id));
    // The single medium slot is busy with the first job; the queue holds the
    // next two distinct capabilities, and the crowder overflows the bound.
    scheduler.enqueue(plan({ capability: 'python', uris: [testUri('C:/proj/p1.py')] }));
    scheduler.enqueue(plan({ capability: 'rust', uris: [testUri('C:/proj/r1.rs')] }));
    scheduler.enqueue(plan({ capability: 'typescript', uris: [testUri('C:/proj/t1.ts')] }));
    scheduler.enqueue(plan({ capability: 'python', uris: [testUri('C:/proj/p2.py')] }));
    expect(overflowed).toHaveLength(1);
    expect(scheduler.queuedCount).toBe(2);
    await waitFor(() => tsc.calls.length === 1);
    gate.resolve();
    await waitFor(() => scheduler.runningCount === 0);
    scheduler.dispose();
    registry.dispose();
  });

  it('runs periodic jobs only when idle', async () => {
    const registry = new ProviderRegistry();
    const save = makeProvider({ id: 'save-provider' });
    const periodic = makeProvider({
      id: 'periodic-provider',
      capabilities: { supportedConfigTypes: ['python'] },
    });
    registry.register(save.provider);
    registry.register(periodic.provider);
    await waitFor(() => registry.getStatus('periodic-provider')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/x.ts')] }));
    await waitFor(() => scheduler.runningCount === 0);
    scheduler.enqueue(plan({ priority: 'periodic', capability: 'python' }));
    expect(periodic.calls).toHaveLength(0); // blocked: save ran moments ago
    await waitFor(() => periodic.calls.length === 1); // idle window elapsed
    scheduler.dispose();
    registry.dispose();
  });

  it('emits onScanJobComplete with the provider that ran and its result', async () => {
    const registry = new ProviderRegistry();
    const tsc = makeProvider({
      id: 'tsc',
      scanImpl: async (context) => {
        const files = context.uris?.map((uri) => ({ uri, diagnostics: [] })) ?? [];
        return { changedUris: context.uris ?? [], files };
      },
    });
    registry.register(tsc.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    const completed: string[] = [];
    scheduler.onScanJobComplete((event) => {
      completed.push(event.providerId);
      expect(event.job.capability).toBe('typescript');
      expect(event.job.type).toBe(ScanType.Save);
      expect(event.result.changedUris).toHaveLength(1);
    });
    scheduler.enqueue(plan());
    await waitFor(() => completed.length === 1);
    expect(completed).toEqual(['tsc']);
    scheduler.dispose();
    registry.dispose();
  });

  it('emits onScanJobFailed and marks the provider Failed when a scan throws', async () => {
    const registry = new ProviderRegistry();
    const tsc = makeProvider({
      id: 'tsc',
      scanImpl: async () => {
        throw new Error('provider exploded');
      },
    });
    registry.register(tsc.provider);
    await waitFor(() => registry.getStatus('tsc')?.health === ProviderHealth.Ready);
    const scheduler = setup(registry);
    const failures: string[] = [];
    scheduler.onScanJobFailed((event) => failures.push(event.providerId));
    scheduler.enqueue(plan());
    await waitFor(() => failures.length === 1);
    expect(registry.getStatus('tsc')?.health).toBe(ProviderHealth.Failed);
    scheduler.dispose();
    registry.dispose();
  });

  it('fails a hung scan via the timeout', async () => {
    const registry = new ProviderRegistry();
    const never = makeProvider({ id: 'hung' });
    never.provider.scan = async () => {
      await new Promise<void>(() => {
        // never resolves — the scheduler timeout must fail the job
      });
      return { changedUris: [] };
    };
    registry.register(never.provider);
    await waitFor(() => registry.getStatus('hung')?.health === ProviderHealth.Ready);
    const scheduler = new ScanScheduler({
      registry,
      scanTimeoutMs: 30,
      idleWindowMs: 50,
    });
    const failures: string[] = [];
    scheduler.onScanJobFailed((event) => failures.push(event.providerId));
    scheduler.enqueue(plan());
    await waitFor(() => failures.length === 1);
    expect(failures).toEqual(['hung']);
    expect(registry.getStatus('hung')?.health).toBe(ProviderHealth.Failed);
    scheduler.dispose();
    registry.dispose();
  });

  it('re-checks health on schedule and dispatches when a provider recovers', async () => {
    const registry = new ProviderRegistry();
    let healthy = false;
    const flaky = makeProvider({ id: 'flaky' });
    flaky.provider.healthCheck = async () =>
      healthy ? { health: ProviderHealth.Ready } : { health: ProviderHealth.Failed };
    registry.register(flaky.provider);
    await waitFor(() => registry.getStatus('flaky')?.health === ProviderHealth.Failed);
    const scheduler = setup(registry);
    scheduler.enqueue(plan());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(flaky.calls).toHaveLength(0); // no Ready provider yet
    healthy = true;
    // Any new schedule attempt re-checks health; recovery fires a status
    // event that pumps the stalled job.
    scheduler.enqueue(plan({ uris: [testUri('C:/proj/b.ts')] }));
    await waitFor(() => flaky.calls.length >= 1);
    scheduler.dispose();
    registry.dispose();
  });

  it('M3 exit criterion: scheduler source references capabilities, not provider ids', () => {
    const source = [
      readFileSync(new URL('../src/scheduler/scan-scheduler.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/scheduler/provider-queue.ts', import.meta.url), 'utf8'),
    ].join('\n');
    for (const forbidden of ['tsc', 'eslint', 'ruff', 'vscode-realtime']) {
      expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    expect(source).toMatch(/getByCapability/);
    expect(source).toMatch(/capability/);
  });
});
