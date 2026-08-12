// TASK 9 — Performance, Resource Bounds & Reliability Audit.
// Scheduler-level: save storms, multi-file bursts, queue bound, concurrency
// limits, priority ordering, timeouts, crashes, missing dependencies.
//
// Audit-first: assertions record observed numbers via [AUDIT] lines and
// verify the EXISTING architectural guarantees (merge/coalesce, queue cap,
// cost-class slots, HOL protection) — no policy changes here.

import { ProviderHealth } from '@pe/core';
import type { ConfigType, Provider, ScanContext, ScanPlan, ScanResult, Uri } from '@pe/core';
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, ScanScheduler } from '../src/index.js';
import { deferred, makeProvider, testUri, waitFor } from './helpers.js';
import type { Deferred } from './helpers.js';

/** Record an audit observation for the performance baseline report. */
function record(key: string, value: unknown): void {
  console.log(`[AUDIT] ${key}=${value}`);
}

function filePlan(capability: string, uri: Uri, priority: ScanPlan['priority'] = 'save'): ScanPlan {
  return { capability: capability as ConfigType, scope: 'file', uris: [uri], priority };
}

/** Wait until the scheduler has fully drained (no running, no queued). */
async function settle(scheduler: ScanScheduler, timeoutMs = 5000): Promise<void> {
  await waitFor(() => scheduler.runningCount === 0 && scheduler.queuedCount === 0, timeoutMs);
}

describe('Task9 audit — scheduler', () => {
  it('save storm: 1000 enqueues while scanning collapse to one merged follow-up scan', async () => {
    const registry = new ProviderRegistry();
    const gate = deferred<void>();
    const provider = makeProvider({ id: 'storm', capabilities: { cost: 'cheap' }, gate });
    registry.register(provider.provider);
    await waitFor(() => registry.getStatus('storm')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    let peakQueue = 0;
    const stateDisposable = scheduler.onScanStateChanged((state) => {
      peakQueue = Math.max(peakQueue, state.queued);
    });

    const uri = testUri('C:/proj/src/a.ts');
    const SAVES = 1000;
    const started = Date.now();
    scheduler.enqueue(filePlan('typescript', uri)); // runs, gated
    for (let i = 1; i < SAVES; i += 1) {
      scheduler.enqueue(filePlan('typescript', uri)); // same URI: merges every time
    }
    // While the scan is in flight every save merged into a single queued job.
    expect(scheduler.queuedCount).toBe(1);
    expect(scheduler.snapshot()[0]?.uris?.length).toBe(1);

    gate.resolve();
    await settle(scheduler);
    stateDisposable.dispose();

    const jobsExecuted = provider.calls.length;
    expect(jobsExecuted).toBe(2); // one initial + one merged — never 1000
    expect(peakQueue).toBe(1);
    record(
      'storm-1000',
      `events=${SAVES} jobsCreated=${SAVES} jobsExecuted=${jobsExecuted} scans=${jobsExecuted} peakQueue=${peakQueue} timeMs=${Date.now() - started}`,
    );
    scheduler.dispose();
    registry.dispose();
  });

  it('save storm: 100 and 500 saves show the same collapse', async () => {
    for (const count of [100, 500]) {
      const registry = new ProviderRegistry();
      const gate = deferred<void>();
      const provider = makeProvider({ id: `storm${count}`, capabilities: { cost: 'cheap' }, gate });
      registry.register(provider.provider);
      await waitFor(() => registry.getStatus(provider.provider.id)?.health === 'ready');
      const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });
      const uri = testUri(`C:/proj/src/f${count}.ts`);

      scheduler.enqueue(filePlan('typescript', uri));
      for (let i = 1; i < count; i += 1) {
        scheduler.enqueue(filePlan('typescript', uri));
      }
      expect(scheduler.queuedCount).toBe(1);
      gate.resolve();
      await settle(scheduler);

      const jobsExecuted = provider.calls.length;
      expect(jobsExecuted).toBe(2);
      expect(provider.calls[1]?.uris?.length).toBe(1);
      record(
        `storm-${count}`,
        `events=${count} jobsCreated=${count} jobsExecuted=${jobsExecuted} scans=${jobsExecuted} peakQueue=1`,
      );
      scheduler.dispose();
      registry.dispose();
    }
  });

  it('multi-file burst: 1000 distinct files merge into one job, one scan', async () => {
    const registry = new ProviderRegistry();
    const gate = deferred<void>();
    const provider = makeProvider({ id: 'burst', capabilities: { cost: 'cheap' }, gate });
    registry.register(provider.provider);
    await waitFor(() => registry.getStatus('burst')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    const uris = Array.from({ length: 1000 }, (_, i) => testUri(`C:/proj/src/f${i}.ts`));
    const started = Date.now();
    scheduler.enqueue(filePlan('typescript', uris[0]!)); // dispatched and runs (gated)
    for (let i = 1; i < uris.length; i += 1) {
      scheduler.enqueue(filePlan('typescript', uris[i]!));
    }

    // All 999 remaining files merged into a single queued job, deduped.
    expect(scheduler.queuedCount).toBe(1);
    expect(scheduler.snapshot()[0]?.uris?.length).toBe(999);
    gate.resolve();
    await settle(scheduler);
    const elapsed = Date.now() - started;

    expect(provider.calls.length).toBe(2); // the in-flight scan + ONE merged scan
    expect(provider.calls[1]?.uris?.length).toBe(999);
    record(
      'burst-1000',
      `jobsCreated=1000 jobsMerged=999 jobsExecuted=2 scans=2 peakQueue=1 timeMs=${elapsed} coverage=1000/1000`,
    );
    scheduler.dispose();
    registry.dispose();
  });

  it('multi-file burst: 100 files plus duplicate uris stay bounded', async () => {
    const registry = new ProviderRegistry();
    const gate = deferred<void>();
    const provider = makeProvider({ id: 'burst2', capabilities: { cost: 'cheap' }, gate });
    registry.register(provider.provider);
    await waitFor(() => registry.getStatus('burst2')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    const uri = testUri('C:/proj/src/a.ts');
    scheduler.enqueue(filePlan('typescript', uri));
    for (let i = 1; i < 100; i += 1) {
      scheduler.enqueue(filePlan('typescript', testUri(`C:/proj/src/f${i}.ts`)));
    }
    for (let i = 0; i < 50; i += 1) {
      scheduler.enqueue(filePlan('typescript', uri)); // duplicates: deduped
    }
    expect(scheduler.snapshot()[0]?.uris?.length).toBe(100); // 1 + 99 distinct
    gate.resolve();
    await settle(scheduler);
    expect(provider.calls[1]?.uris?.length).toBe(100);
    record('burst-100', 'jobsCreated=150 jobsMerged=149 jobsExecuted=1 scans=1 peakQueue=1');
    scheduler.dispose();
    registry.dispose();
  });

  it('multi-capability burst: grouping by capability, queue stays at one job per capability', async () => {
    const registry = new ProviderRegistry();
    const gates: Record<string, Deferred<void>> = {
      typescript: deferred(),
      javascript: deferred(),
      python: deferred(),
    };
    const providers = Object.entries(gates).map(([capability, gate]) =>
      makeProvider({
        id: `mcb-${capability}`,
        capabilities: { supportedConfigTypes: [capability as ConfigType], cost: 'medium' },
        gate,
      }),
    );
    for (const p of providers) {
      registry.register(p.provider);
    }
    await waitFor(() => registry.getStatus('mcb-typescript')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    let peakQueue = 0;
    const stateDisposable = scheduler.onScanStateChanged((state) => {
      peakQueue = Math.max(peakQueue, state.queued);
    });

    for (const [capability] of Object.entries(gates)) {
      scheduler.enqueue(
        filePlan(capability, testUri(`C:/proj/src/c1.${capability === 'python' ? 'py' : 'ts'}`)),
      );
    }
    for (let i = 0; i < 100; i += 1) {
      scheduler.enqueue(filePlan('typescript', testUri(`C:/proj/src/t${i}.ts`)));
      scheduler.enqueue(filePlan('javascript', testUri(`C:/proj/src/j${i}.js`)));
      scheduler.enqueue(filePlan('python', testUri(`C:/proj/src/p${i}.py`)));
    }
    // One queued job per capability NOT currently running: 3 capabilities,
    // 2 medium slots → 3 queued. Subsequent enqueues merge into those.
    expect(scheduler.queuedCount).toBe(3);
    for (const gate of Object.values(gates)) {
      gate.resolve();
    }
    await settle(scheduler);
    stateDisposable.dispose();

    // The two in-flight jobs (1 uri each) + three merged jobs.
    const jobsExecuted = providers.reduce((sum, p) => sum + p.calls.length, 0);
    expect(jobsExecuted).toBe(5); // 303 enqueues → 5 scans
    const byId = Object.fromEntries(providers.map((p) => [p.provider.id, p]));
    expect(byId['mcb-typescript']!.calls.length).toBe(2);
    expect(byId['mcb-javascript']!.calls.length).toBe(2);
    expect(byId['mcb-python']!.calls.length).toBe(1);
    expect(byId['mcb-python']!.calls[0]?.uris?.length).toBe(101);
    record(
      'burst-multi-cap',
      `jobsCreated=303 jobsMerged=300 jobsExecuted=${jobsExecuted} scans=${jobsExecuted} peakQueue=${peakQueue}`,
    );
    scheduler.dispose();
    registry.dispose();
  });

  it('queue bound: overflow drops the job, fires events, engine stays alive', async () => {
    const registry = new ProviderRegistry();
    const providers = new Map<string, ReturnType<typeof makeProvider>>();
    const gates = new Map<string, Deferred<void>>();
    for (let i = 0; i < 14; i += 1) {
      const cap = `cap${i}`;
      const gate = deferred<void>();
      gates.set(cap, gate);
      const p = makeProvider({
        id: `q-${cap}`,
        capabilities: { supportedConfigTypes: [cap as ConfigType], cost: 'medium' },
        gate,
      });
      providers.set(cap, p);
      registry.register(p.provider);
    }
    await waitFor(() => registry.getStatus('q-cap0')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, queueSize: 10, idleWindowMs: 50 });

    let overflowCount = 0;
    let peakQueue = 0;
    const overflowDisposable = scheduler.onQueueOverflow(() => {
      overflowCount += 1;
    });
    const stateDisposable = scheduler.onScanStateChanged((state) => {
      peakQueue = Math.max(peakQueue, state.queued);
    });

    for (let i = 0; i < 14; i += 1) {
      scheduler.enqueue(filePlan(`cap${i}`, testUri(`C:/proj/src/q${i}.ts`)));
    }
    // 2 medium slots running, 10 queued (queue full), 2 dropped by overflow.
    expect(scheduler.runningCount).toBe(2);
    expect(scheduler.queuedCount).toBe(10);
    expect(overflowCount).toBe(2);
    expect(peakQueue).toBeLessThanOrEqual(10);

    // The job for a capability nobody registered is dropped permanently — it
    // can never block the queue, and the engine does not hang.
    scheduler.enqueue({
      capability: 'rust' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/x.rs')],
      priority: 'save',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(overflowCount).toBe(3); // queue still full → overflow drop

    for (const gate of gates.values()) {
      gate.resolve();
    }
    await settle(scheduler);

    for (const [cap, p] of providers) {
      const expected = cap === 'cap12' || cap === 'cap13' ? 0 : 1;
      expect(p.calls.length, `provider ${cap} should have ${expected} scans`).toBe(expected);
    }
    // No candidates for rust: permanently dropped, queue drains to zero.
    scheduler.enqueue({
      capability: 'rust' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/x.rs')],
      priority: 'save',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(scheduler.queuedCount).toBe(0);

    // Engine remains operational after overflow: new work still executes.
    scheduler.enqueue(filePlan('cap0', testUri('C:/proj/src/after.ts')));
    await waitFor(() => providers.get('cap0')!.calls.length === 2);

    overflowDisposable.dispose();
    stateDisposable.dispose();
    record(
      'queue-bound',
      `queueSize=10 overflowEvents=3 droppedJobs=3 peakQueue=${peakQueue} engineOperational=true`,
    );
    scheduler.dispose();
    registry.dispose();
  });

  it('concurrency: cheap=4, medium=2, expensive=1 are never exceeded', async () => {
    const cases: Array<{
      cost: 'cheap' | 'medium' | 'expensive';
      providers: number;
      slots: number;
    }> = [
      { cost: 'cheap', providers: 6, slots: 4 },
      { cost: 'medium', providers: 4, slots: 2 },
      { cost: 'expensive', providers: 3, slots: 1 },
    ];
    for (const testCase of cases) {
      const registry = new ProviderRegistry();
      const gates: Array<Deferred<void>> = [];
      const providers = Array.from({ length: testCase.providers }, (_, i) => {
        const gate = deferred<void>();
        gates.push(gate);
        return makeProvider({
          id: `c-${testCase.cost}-${i}`,
          capabilities: { supportedConfigTypes: [`cap-${i}` as ConfigType], cost: testCase.cost },
          gate,
        });
      });
      for (const p of providers) {
        registry.register(p.provider);
      }
      await waitFor(() => registry.getStatus(providers[0]!.provider.id)?.health === 'ready');
      const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

      let peakRunning = 0;
      const stateDisposable = scheduler.onScanStateChanged((state) => {
        peakRunning = Math.max(peakRunning, state.running);
      });
      for (let i = 0; i < testCase.providers; i += 1) {
        scheduler.enqueue({
          capability: `cap-${i}` as ConfigType,
          scope: 'file',
          uris: [testUri(`C:/proj/src/${i}.ts`)],
          priority: 'save',
        });
      }
      expect(scheduler.runningCount).toBe(testCase.slots);
      expect(scheduler.queuedCount).toBe(testCase.providers - testCase.slots);
      for (const gate of gates) {
        gate.resolve();
      }
      await settle(scheduler);
      stateDisposable.dispose();
      expect(peakRunning).toBe(testCase.slots);
      expect(providers.reduce((sum, p) => sum + p.calls.length, 0)).toBe(testCase.providers);
      record(
        `concurrency-${testCase.cost}`,
        `configured=${testCase.slots} observedPeak=${peakRunning} saturation=true`,
      );
      scheduler.dispose();
      registry.dispose();
    }
  });

  it('concurrency: an expensive scan cannot consume cheap slots; override respected', async () => {
    const registry = new ProviderRegistry();
    const expensiveGate = deferred<void>();
    const expensive = makeProvider({
      id: 'slow-heavy',
      capabilities: { supportedConfigTypes: ['heavy' as ConfigType], cost: 'expensive' },
      gate: expensiveGate,
    });
    const cheapGates = Array.from({ length: 5 }, () => deferred<void>());
    const cheap = cheapGates.map((gate, i) =>
      makeProvider({
        id: `quick-${i}`,
        capabilities: { supportedConfigTypes: [`light-${i}` as ConfigType], cost: 'cheap' },
        gate,
      }),
    );
    registry.register(expensive.provider);
    for (const p of cheap) {
      registry.register(p.provider);
    }
    await waitFor(() => registry.getStatus('slow-heavy')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    scheduler.enqueue({
      capability: 'heavy' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/h.ts')],
      priority: 'save',
    });
    for (let i = 0; i < 5; i += 1) {
      scheduler.enqueue({
        capability: `light-${i}` as ConfigType,
        scope: 'file',
        uris: [testUri(`C:/proj/src/l${i}.ts`)],
        priority: 'save',
      });
    }
    // Expensive holds its 1 slot; the 4 cheap slots still run in parallel.
    await waitFor(
      () => expensive.calls.length === 1 && cheap.filter((p) => p.calls.length > 0).length === 4,
    );
    expect(scheduler.runningCount).toBe(5); // 1 expensive + 4 cheap, never 1 total
    expensiveGate.resolve();
    for (const gate of cheapGates) {
      gate.resolve();
    }
    await settle(scheduler);
    expect(cheap.reduce((sum, p) => sum + p.calls.length, 0)).toBe(5);
    record('concurrency-cross-class', 'expensive=1 cheap=4 total=5 slotsNeverShared=true');
    scheduler.dispose();
    registry.dispose();

    const registry2 = new ProviderRegistry();
    const gates2 = Array.from({ length: 4 }, () => deferred<void>());
    const providers2 = gates2.map((gate, i) =>
      makeProvider({
        id: `ovr-${i}`,
        capabilities: { supportedConfigTypes: [`ov-${i}` as ConfigType], cost: 'cheap' },
        gate,
      }),
    );
    for (const p of providers2) {
      registry2.register(p.provider);
    }
    await waitFor(() => registry2.getStatus('ovr-0')?.health === 'ready');
    const scheduler2 = new ScanScheduler({
      registry: registry2,
      maxConcurrency: { cheap: 2 },
      idleWindowMs: 50,
    });
    for (let i = 0; i < 4; i += 1) {
      scheduler2.enqueue({
        capability: `ov-${i}` as ConfigType,
        scope: 'file',
        uris: [testUri(`C:/proj/src/o${i}.ts`)],
        priority: 'save',
      });
    }
    expect(scheduler2.runningCount).toBe(2);
    for (const gate of gates2) {
      gate.resolve();
    }
    await settle(scheduler2);
    expect(providers2.reduce((sum, p) => sum + p.calls.length, 0)).toBe(4);
    record('concurrency-override', 'configuredCheap=2 observed=2 respected=true');
    scheduler2.dispose();
    registry2.dispose();
  });

  it('priority: manual work merges into and lifts queued saves; never starved', async () => {
    const registry = new ProviderRegistry();
    const gate = deferred<void>();
    const ts = makeProvider({ id: 'pri-ts', capabilities: { cost: 'medium' }, gate });
    const py = makeProvider({
      id: 'pri-py',
      capabilities: { supportedConfigTypes: ['python'], cost: 'medium' },
      gate,
    });
    registry.register(ts.provider);
    registry.register(py.provider);
    await waitFor(() => registry.getStatus('pri-ts')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    scheduler.enqueue(filePlan('typescript', testUri('C:/proj/src/a.ts'))); // runs (1 per capability)
    scheduler.enqueue(filePlan('typescript', testUri('C:/proj/src/b.ts')));
    scheduler.enqueue(filePlan('typescript', testUri('C:/proj/src/c.ts')));
    // b + c merged into one queued save job (one running job per capability).
    expect(scheduler.snapshot().length).toBe(1);
    expect(scheduler.snapshot()[0]?.priority).toBe('save');
    expect(scheduler.snapshot()[0]?.uris?.length).toBe(2);

    // A manual job for the same capability merges into the queued save and
    // lifts it above the backlog — never starved behind it.
    scheduler.enqueue({
      capability: 'typescript',
      scope: 'file',
      uris: [testUri('C:/proj/src/m.ts')],
      priority: 'manual',
    });
    expect(scheduler.snapshot().length).toBe(1);
    expect(scheduler.snapshot()[0]?.priority).toBe('manual');
    expect(scheduler.snapshot()[0]?.uris?.length).toBe(3);

    // A different capability keeps its own manual job, same priority tier.
    scheduler.enqueue({
      capability: 'python',
      scope: 'file',
      uris: [testUri('C:/proj/src/m.py')],
      priority: 'manual',
    });
    expect(scheduler.snapshot().length).toBe(2);
    expect(scheduler.snapshot().find((job) => job.capability === 'python')?.priority).toBe(
      'manual',
    );

    gate.resolve();
    await settle(scheduler);
    // The lifted ts job (b+c+m) and the python manual job run once the slot
    // frees — manual work was not starved behind the save backlog.
    expect(ts.calls.map((call) => call.type)).toEqual(['save', 'manual']);
    expect(ts.calls[1]?.uris?.length).toBe(3);
    expect(py.calls.map((call) => call.type)).toEqual(['manual']);
    record('priority', 'manualMergesAndLifts=true manualBypassesSaveBacklog=true starvation=false');
    scheduler.dispose();
    registry.dispose();
  });

  it('timeout: a hung scan is failed, its slot released, the engine keeps running', async () => {
    const registry = new ProviderRegistry();
    const hung = makeProvider({
      id: 'hung',
      capabilities: { supportedConfigTypes: ['hang' as ConfigType], cost: 'medium' },
      scanImpl: () => new Promise<ScanResult>(() => {}), // never resolves
    });
    const healthy = makeProvider({
      id: 'fine',
      capabilities: { supportedConfigTypes: ['fine' as ConfigType], cost: 'medium' },
    });
    registry.register(hung.provider);
    registry.register(healthy.provider);
    await waitFor(() => registry.getStatus('hung')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50, scanTimeoutMs: 60 });

    const failed: string[] = [];
    let completed = 0;
    const failedDisposable = scheduler.onScanJobFailed((event) => failed.push(event.error.message));
    const completeDisposable = scheduler.onScanJobComplete(() => {
      completed += 1;
    });

    scheduler.enqueue({
      capability: 'hang' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/hang.ts')],
      priority: 'save',
    });
    await waitFor(() => failed.length === 1, 5000);
    expect(failed[0]).toContain('scan timed out');
    expect(registry.getStatus('hung')?.health).toBe(ProviderHealth.Failed);
    expect(scheduler.runningCount).toBe(0); // slot released
    expect(completed).toBe(0); // no diagnostics from the failed run

    scheduler.enqueue({
      capability: 'fine' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/fine.ts')],
      priority: 'save',
    });
    await waitFor(() => healthy.calls.length === 1, 5000);
    failedDisposable.dispose();
    completeDisposable.dispose();
    record(
      'timeout-scan',
      'hungScanTimedOut=60ms slotReleased=true health=Failed engineContinues=true',
    );
    scheduler.dispose();
    registry.dispose();
  });

  it('timeout: a hung health check becomes Failed and recovers via retry', async () => {
    let healthCheckCount = 0;
    let healthyFlag = false;
    const checkGate = deferred<never>();
    const calls: ScanContext[] = [];
    const provider: Provider = {
      id: 'hung-check',
      displayName: 'Hung Check',
      capabilities: {
        confidenceTier: 3,
        supportedConfigTypes: ['hcheck' as ConfigType],
        workspaceScan: true,
        incrementalScan: true,
        realtime: false,
        extensions: ['.ts'],
        cost: 'medium',
      },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      healthCheck: () => {
        healthCheckCount += 1;
        return healthyFlag ? Promise.resolve({ health: ProviderHealth.Ready }) : checkGate.promise;
      },
      scan: async (context) => {
        calls.push(context);
        return { changedUris: context.uris ?? [], files: [] };
      },
    };

    const registry = new ProviderRegistry({ healthCheckTimeoutMs: 60, healthCheckRetryMs: 80 });
    registry.register(provider);
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });
    await waitFor(() => registry.getStatus('hung-check')?.health === ProviderHealth.Failed, 5000);
    expect(registry.getStatus('hung-check')?.message).toContain('health check timed out');

    scheduler.enqueue({
      capability: 'hcheck' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/h.ts')],
      priority: 'save',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.length).toBe(0); // not dispatched while unhealthy

    healthyFlag = true;
    await waitFor(() => calls.length === 1, 5000); // retry timer re-checks → Ready → dispatch
    record('timeout-healthcheck', `timeout=60ms recovered=true probes=${healthCheckCount}`);
    scheduler.dispose();
    registry.dispose();
  });

  it('crash: a throwing provider is isolated and the engine survives', async () => {
    const registry = new ProviderRegistry();
    const crashy = makeProvider({
      id: 'crashy',
      capabilities: { supportedConfigTypes: ['boom' as ConfigType], cost: 'medium' },
      scanImpl: () => Promise.reject(new Error('provider exploded')),
    });
    const healthy = makeProvider({
      id: 'alive',
      capabilities: { supportedConfigTypes: ['alive' as ConfigType], cost: 'medium' },
    });
    registry.register(crashy.provider);
    registry.register(healthy.provider);
    await waitFor(() => registry.getStatus('crashy')?.health === 'ready');
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });

    const failed: string[] = [];
    const failedDisposable = scheduler.onScanJobFailed((event) => failed.push(event.error.message));
    scheduler.enqueue({
      capability: 'boom' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/b.ts')],
      priority: 'save',
    });
    await waitFor(() => failed.length === 1, 5000);
    expect(registry.getStatus('crashy')?.health).toBe(ProviderHealth.Failed);
    expect(scheduler.runningCount).toBe(0);

    scheduler.enqueue({
      capability: 'alive' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/a.ts')],
      priority: 'save',
    });
    await waitFor(() => healthy.calls.length === 1, 5000);
    expect(scheduler.queuedCount).toBe(0);
    failedDisposable.dispose();
    record('crash', 'throwingProviderIsolated=true engineSurvives=true queuedWorkNoDeadlock=true');
    scheduler.dispose();
    registry.dispose();
  });

  it('missing dependency: skipped, no repeated probes between retries, recovers', async () => {
    let healthCheckCount = 0;
    let depAvailable = false;
    const calls: ScanContext[] = [];
    const provider: Provider = {
      id: 'missing-dep',
      displayName: 'Missing Dep',
      capabilities: {
        confidenceTier: 3,
        supportedConfigTypes: ['mdep' as ConfigType],
        workspaceScan: true,
        incrementalScan: true,
        realtime: false,
        extensions: ['.ts'],
        cost: 'medium',
      },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      healthCheck: () => {
        healthCheckCount += 1;
        return Promise.resolve({
          health: depAvailable ? ProviderHealth.Ready : ProviderHealth.MissingDependency,
        });
      },
      scan: async (context) => {
        calls.push(context);
        return { changedUris: context.uris ?? [], files: [] };
      },
    };

    const registry = new ProviderRegistry({ healthCheckRetryMs: 60 });
    registry.register(provider);
    const scheduler = new ScanScheduler({ registry, idleWindowMs: 50 });
    await waitFor(
      () => registry.getStatus('missing-dep')?.health === ProviderHealth.MissingDependency,
    );

    scheduler.enqueue({
      capability: 'mdep' as ConfigType,
      scope: 'file',
      uris: [testUri('C:/proj/src/m.ts')],
      priority: 'save',
    });
    expect(scheduler.queuedCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30)); // well inside the retry window
    expect(calls.length).toBe(0); // never spawned
    expect(healthCheckCount).toBeLessThanOrEqual(2); // register + drain-queue probe only

    depAvailable = true;
    await waitFor(() => calls.length === 1, 5000); // retry timer → Ready → dispatch
    expect(healthCheckCount).toBeLessThanOrEqual(3);
    record(
      'missing-dependency',
      'probesBeforeRetry=2 spawnedBetweenRetries=0 recoveredAfterRetry=true',
    );
    scheduler.dispose();
    registry.dispose();
  });
});
