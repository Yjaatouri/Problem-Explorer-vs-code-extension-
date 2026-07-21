import * as assert from 'assert';
import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager, ProviderState } from '../../providers/DiagnosticProviderManager';
import { TelemetryBus, getTelemetryBus, resetTelemetryBus } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { BusTelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetryConfigManager } from '../../telemetry/TelemetryConfig';
import { ProblemSeverity, ProblemState } from '../../core/types';
import { createStoreMonitor } from '../../telemetry/monitors/StoreMonitor';
import { createProviderMonitor } from '../../telemetry/monitors/ProviderMonitor';
import { createTimerMonitor } from '../../telemetry/monitors/TimerMonitor';
import { createEventPipelineMonitor } from '../../telemetry/monitors/EventPipelineMonitor';
import { createTimelineGenerator } from '../../telemetry/monitors/TimelineGenerator';
import { createSnapshotSystem } from '../../telemetry/monitors/SnapshotSystem';

function makeState(overrides?: Partial<ProblemState>): ProblemState {
  return {
    severity: ProblemSeverity.Error,
    errorCount: 1,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
    ...overrides,
  };
}

function makeConfigManager(): TelemetryConfigManager {
  return new TelemetryConfigManager({
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
    }),
  });
}

suite('Telemetry Monitors', () => {
  let bus: TelemetryBus;
  let config: TelemetryConfigManager;
  let collected: TelemetryEvent[];

  setup(() => {
    resetTelemetryBus();
    bus = getTelemetryBus();
    bus.setEnabled(true);
    config = makeConfigManager();
    collected = [];
  });

  teardown(() => {
    resetTelemetryBus();
  });

  /* ------------------------------------------------------------------ */
  /*  Foundation: BusTelemetryReporter                                   */
  /* ------------------------------------------------------------------ */

  suite('BusTelemetryReporter', () => {
    test('publishes events when enabled', () => {
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      reporter.report({ type: 'test.event', timestamp: Date.now(), traceId: '' as any });
      assert.strictEqual(collected.length, 1);
      assert.strictEqual(collected[0].type, 'test.event');
    });

    test('subscribe filters by type', () => {
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribe('test.alpha', (e) => collected.push(e));
      reporter.report({ type: 'test.beta', timestamp: Date.now(), traceId: '' as any });
      reporter.report({ type: 'test.alpha', timestamp: Date.now(), traceId: '' as any });
      assert.strictEqual(collected.length, 1);
      assert.strictEqual(collected[0].type, 'test.alpha');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  StoreMonitor                                                       */
  /* ------------------------------------------------------------------ */

  suite('StoreMonitor', () => {
    test('publishes store.set on ProblemStore.set', () => {
      const store = new ProblemStore();
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createStoreMonitor(store, reporter);

      const uri = Uri.parse('file:///project/a.ts');
      store.set(uri, makeState());

      const setEvents = collected.filter((e) => e.type === 'store.set');
      assert.ok(setEvents.length >= 1, 'Expected at least one store.set event');
    });

    test('publishes store.delete on ProblemStore.delete', () => {
      const store = new ProblemStore();
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createStoreMonitor(store, reporter);

      const uri = Uri.parse('file:///project/del.ts');
      store.set(uri, makeState());
      store.delete(uri);

      const delEvents = collected.filter((e) => e.type === 'store.delete');
      assert.ok(delEvents.length >= 1, 'Expected at least one store.delete event');
    });

    test('publishes store.clear on ProblemStore.clear', () => {
      const store = new ProblemStore();
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createStoreMonitor(store, reporter);

      store.set(Uri.parse('file:///project/a.ts'), makeState());
      store.clear();

      const clearEvents = collected.filter((e) => e.type === 'store.clear');
      assert.ok(clearEvents.length >= 1, 'Expected at least one store.clear event');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  ProviderMonitor                                                    */
  /* ------------------------------------------------------------------ */

  suite('ProviderMonitor', () => {
    test('publishes provider.registry on register', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createProviderMonitor(manager, reporter);

      const fakeProvider = { name: 'testProvider', onDidUpdate: () => ({ dispose: () => {} }), onDidProgressScan: () => ({ dispose: () => {} }) };
      manager.register('testProvider', fakeProvider as any, { priority: 5 });

      const regEvents = collected.filter((e) => e.type === 'provider.registry');
      assert.ok(regEvents.length >= 1, 'Expected provider.registry event');
    });

    test('publishes provider.lifecycle on state change', () => {
      const manager = new DiagnosticProviderManager();
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createProviderMonitor(manager, reporter);

      const fakeProvider = { name: 'lifecycleTest', onDidUpdate: () => ({ dispose: () => {} }), onDidProgressScan: () => ({ dispose: () => {} }) };
      manager.register('lifecycleTest', fakeProvider as any, { priority: 5 });
      manager.setProviderState('lifecycleTest', ProviderState.error);

      const lifecycleEvents = collected.filter((e) => e.type === 'provider.lifecycle');
      assert.ok(lifecycleEvents.length >= 1, 'Expected provider.lifecycle event');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  TimerMonitor                                                       */
  /* ------------------------------------------------------------------ */

  suite('TimerMonitor', () => {
    test('publishes timer.setTimeout on setTimeout call', (done) => {
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createTimerMonitor(reporter);

      // Use a short timeout so the test doesn't hang
      const id = setTimeout(() => {
        const setEvents = collected.filter((e) => e.type === 'timer.setTimeout');
        assert.ok(setEvents.length >= 1, 'Expected timer.setTimeout event');
        done();
      }, 5);

      // If the timer hasn't fired yet, we should have at least the set event queued
      // but clearTimeout to avoid issues
      clearTimeout(id);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  EventPipelineMonitor                                               */
  /* ------------------------------------------------------------------ */

  suite('EventPipelineMonitor', () => {
    test('detects duplicate events with same traceId and type within window', () => {
      const reporter = new BusTelemetryReporter(config, bus);
      reporter.subscribeAll((e) => collected.push(e));
      createEventPipelineMonitor(reporter);

      const traceId = 'dup-test-trace' as any;
      const ts = Date.now();
      for (let i = 0; i < 3; i++) {
        reporter.report({ type: 'store.set', timestamp: ts + i, traceId });
      }

      const dupEvents = collected.filter((e) => e.type === 'pipeline.duplicateEvent');
      assert.ok(dupEvents.length >= 1, 'Expected pipeline.duplicateEvent for repeated store.set');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  TimelineGenerator                                                  */
  /* ------------------------------------------------------------------ */

  suite('TimelineGenerator', () => {
    test('stores events by traceId and generates report', () => {
      const reporter = new BusTelemetryReporter(config, bus);
      const timeline = createTimelineGenerator(reporter);

      const traceId = 'timeline-test-001' as any;
      reporter.report({ type: 'store.set', timestamp: 1000, traceId, source: 'test' });
      reporter.report({ type: 'store.delete', timestamp: 1100, traceId, source: 'test' });
      reporter.report({ type: 'store.clear', timestamp: 1200, traceId, source: 'test' });

      const events = timeline.getEvents(traceId);
      assert.strictEqual(events.length, 3, 'Expected 3 events stored for traceId');

      const report = timeline.generateReport(traceId);
      assert.strictEqual(report.entries.length, 3);
      assert.strictEqual(report.totalDurationMs, 200);
    });

    test('returns empty report for unknown traceId', () => {
      const reporter = new BusTelemetryReporter(config, bus);
      const timeline = createTimelineGenerator(reporter);
      const report = timeline.generateReport('unknown' as any);
      assert.strictEqual(report.entries.length, 0);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  SnapshotSystem                                                     */
  /* ------------------------------------------------------------------ */

  suite('SnapshotSystem', () => {
    test('captures store state from linked ProblemStore', () => {
      const store = new ProblemStore();
      const reporter = new BusTelemetryReporter(config, bus);
      const snapshot = createSnapshotSystem(reporter, store);

      store.set(Uri.parse('file:///project/a.ts'), makeState({ errorCount: 3 }));
      store.set(Uri.parse('file:///project/b.ts'), makeState({ warningCount: 2 }));

      const state = snapshot.captureSnapshot();
      assert.strictEqual(state.store.totalErrors, 3);
      assert.strictEqual(state.store.totalWarnings, 2);
      assert.strictEqual(state.store.entryCount, 2);
    });

    test('captures empty state when no ProblemStore linked', () => {
      const reporter = new BusTelemetryReporter(config, bus);
      const snapshot = createSnapshotSystem(reporter);
      const state = snapshot.captureSnapshot();
      assert.strictEqual(state.store.entryCount, 0);
    });
  });
});
