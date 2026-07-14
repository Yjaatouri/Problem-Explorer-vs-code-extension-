import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProblemStore } from '../../store/ProblemStore';
import { TrendTracker, StorageProvider } from '../../trend/trendTracker';
import { ProblemSeverity } from '../../core/types';

class InMemoryStorage implements StorageProvider {
  private data = new Map<string, unknown>();

  get<T>(_key: string, defaultValue: T): T {
    const v = this.data.get(_key);
    return v !== undefined ? (v as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

suite('TrendTracker', () => {
  let store: ProblemStore;
  let storage: InMemoryStorage;
  let tracker: TrendTracker;

  setup(() => {
    store = new ProblemStore();
    storage = new InMemoryStorage();
    tracker = new TrendTracker(store, storage, {
      intervalMs: 10000,
      maxSnapshots: 5,
      storageKey: 'test.trend',
    });
  });

  teardown(() => {
    tracker.stop();
  });

  suite('getHistory / takeSnapshot', () => {
    test('returns empty array initially', () => {
      assert.deepStrictEqual(tracker.getHistory(), []);
    });

    test('single snapshot captures current totals', () => {
      const file = Uri.parse('file:///root/file.ts');
      store.set(file, {
        severity: ProblemSeverity.Error,
        errorCount: 3,
        warningCount: 2,
        infoCount: 1,
        fileCount: 1,
      });
      tracker.takeSnapshot();
      const history = tracker.getHistory();
      assert.strictEqual(history.length, 1);
      const snap = history[0];
      assert.strictEqual(snap.errorCount, 3);
      assert.strictEqual(snap.warningCount, 2);
      assert.strictEqual(snap.infoCount, 1);
      assert.ok(snap.timestamp > 0);
    });

    test('multiple snapshots are appended', () => {
      tracker.takeSnapshot();
      tracker.takeSnapshot();
      assert.strictEqual(tracker.getHistory().length, 2);
    });

    test('history is trimmed to maxSnapshots', () => {
      tracker = new TrendTracker(store, storage, {
        intervalMs: 10000,
        maxSnapshots: 3,
        storageKey: 'test.trend',
      });
      for (let i = 0; i < 5; i++) {
        tracker.takeSnapshot();
      }
      assert.strictEqual(tracker.getHistory().length, 3);
    });
  });

  suite('start / stop', () => {
    test('start takes initial snapshot and sets timer', () => {
      assert.strictEqual(tracker.running, false);
      assert.strictEqual(tracker.getHistory().length, 0);
      tracker.start();
      assert.strictEqual(tracker.running, true);
      assert.strictEqual(tracker.getHistory().length, 1);
      tracker.stop();
    });

    test('stop clears the timer', () => {
      tracker.start();
      assert.strictEqual(tracker.running, true);
      tracker.stop();
      assert.strictEqual(tracker.running, false);
    });

    test('periodic snapshots accumulate over time', () => {
      const clock = sinon.useFakeTimers();
      try {
        tracker = new TrendTracker(store, storage, {
          intervalMs: 1000,
          maxSnapshots: 10,
          storageKey: 'test.trend',
        });
        tracker.start();
        assert.strictEqual(tracker.getHistory().length, 1); // initial
        clock.tick(1000);
        assert.strictEqual(tracker.getHistory().length, 2);
        clock.tick(1000);
        assert.strictEqual(tracker.getHistory().length, 3);
        tracker.stop();
        clock.tick(1000);
        assert.strictEqual(tracker.getHistory().length, 3); // no more after stop
      } finally {
        clock.restore();
      }
    });
  });

  suite('persistence', () => {
    test('history survives tracker instance recreation', () => {
      const file = Uri.parse('file:///root/file.ts');
      store.set(file, {
        severity: ProblemSeverity.Error,
        errorCount: 5,
        warningCount: 0,
        infoCount: 0,
        fileCount: 1,
      });
      tracker.takeSnapshot();
      assert.strictEqual(tracker.getHistory()[0].errorCount, 5);

      const tracker2 = new TrendTracker(store, storage, {
        intervalMs: 10000,
        maxSnapshots: 5,
        storageKey: 'test.trend',
      });
      const history = tracker2.getHistory();
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].errorCount, 5);
      tracker2.stop();
    });
  });
});

import { Uri } from 'vscode';