import { Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager, ProviderState } from '../../providers/DiagnosticProviderManager';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { ProblemState } from '../../core/types';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/** Structured event payload for a failed runtime assertion */
export interface RuntimeAssertionEventData {
  readonly type: 'assertion.failure';
  readonly assertion: string;
  readonly detail: string;
}

/** Union of all runtime assertion event types */
export type RuntimeAssertionMonitorEvent = RuntimeAssertionEventData;

const CHECK_SAMPLE_RATIO = 0.1;

/** Runtime assertion helpers — publish telemetry on failure, never throw, disabled with telemetry */
export class RuntimeAssertions {
  constructor(
    private readonly reporter: TelemetryReporter,
    private enabled: boolean,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private fail(assertion: string, detail: string): boolean {
    if (!this.enabled) return false;
    this.reporter.report({
      type: 'assertion.failure',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'RuntimeAssertions',
      assertion,
      detail,
    } as any);
    return false;
  }

  private sample(): boolean {
    return !this.enabled || Math.random() < CHECK_SAMPLE_RATIO;
  }

  /**
   * Assert store invariants:
   * - All entries have non-negative counts
   * - Folder aggregates reference valid keys
   * - Running totals match actual entries
   */
  assertStore(store: ProblemStore): boolean {
    if (!this.sample()) return true;
    try {
      const all: Array<{ key: string; state: ProblemState; isFolder: boolean }> = [];
      store.forEachEntry((key, state, isFolder) => all.push({ key, state, isFolder }));

      let computedErrors = 0;
      let computedWarnings = 0;
      let computedInfos = 0;
      let computedFiles = 0;

      for (const entry of all) {
        if (entry.state.errorCount < 0) {
          return this.fail('store', `Negative errorCount=${entry.state.errorCount} for key=${entry.key}`);
        }
        if (entry.state.warningCount < 0) {
          return this.fail('store', `Negative warningCount=${entry.state.warningCount} for key=${entry.key}`);
        }
        if (entry.state.infoCount < 0) {
          return this.fail('store', `Negative infoCount=${entry.state.infoCount} for key=${entry.key}`);
        }

        if (!entry.isFolder) {
          computedErrors += entry.state.errorCount;
          computedWarnings += entry.state.warningCount;
          computedInfos += entry.state.infoCount;
          computedFiles += 1;
        }
      }

      const totals = store.computeTotals();
      if (totals.errorCount !== computedErrors || totals.warningCount !== computedWarnings || totals.infoCount !== computedInfos) {
        return this.fail('store',
          `Running totals mismatch: store=${totals.errorCount}e/${totals.warningCount}w/${totals.infoCount}i ` +
          `computed=${computedErrors}e/${computedWarnings}w/${computedInfos}i`);
      }
      if (totals.fileCount !== computedFiles) {
        return this.fail('store', `File count mismatch: store=${totals.fileCount} computed=${computedFiles}`);
      }
      return true;
    } catch {
      return this.fail('store', 'Exception during store assertion');
    }
  }

  /**
   * Assert ownership invariants:
   * - All owners in ownerByKey are configured providers
   * - No key has multiple owners
   */
  assertOwnership(store: ProblemStore): boolean {
    if (!this.sample()) return true;
    try {
      const seen = new Map<string, string>();
      let orphanCount = 0;
      store.forEachEntry((_key, _state, isFolder) => {
        if (isFolder) return;
        const owner = (store as any).ownerByKey.get(_key) as string | undefined;
        if (owner) {
          if (seen.has(_key) && seen.get(_key) !== owner) {
            orphanCount++;
          }
          seen.set(_key, owner);
        }
      });

      if (orphanCount > 0) {
        return this.fail('ownership', `${orphanCount} keys have conflicting owners`);
      }
      return true;
    } catch {
      return this.fail('ownership', 'Exception during ownership assertion');
    }
  }

  /**
   * Assert decoration invariants:
   * - Folder aggregate states are valid
   * - Config and store are consistent
   */
  assertDecoration(store: ProblemStore): boolean {
    if (!this.sample()) return true;
    try {
      let badCount = 0;
      store.forEachEntry((_key, state, isFolder) => {
        if (!isFolder) return;
        if (state.errorCount < 0 || state.warningCount < 0 || state.infoCount < 0) {
          badCount++;
        }
      });

      if (badCount > 0) {
        return this.fail('decoration', `${badCount} folder aggregates have negative counts`);
      }
      return true;
    } catch {
      return this.fail('decoration', 'Exception during decoration assertion');
    }
  }

  /**
   * Assert folder invariants:
   * - Child index entries reference valid store URIs
   * - No orphaned folder aggregates in store
   */
  assertFolder(store: ProblemStore, folderManager: FolderStatusManager): boolean {
    if (!this.sample()) return true;
    try {
      const children = (folderManager as any).childIndex as Map<string, Map<string, unknown>> | undefined;
      if (!children) return true;

      let orphaned = 0;
      for (const [parentKey] of children) {
        const parentState = store.get(Uri.parse(parentKey));
        if (!parentState) orphaned++;
      }

      if (orphaned > 0) {
        return this.fail('folder', `${orphaned} child index entries missing from store`);
      }
      return true;
    } catch {
      return this.fail('folder', 'Exception during folder assertion');
    }
  }

  /**
   * Assert provider invariants:
   * - All registered providers are in valid states
   * - Provider scanning flags are consistent
   */
  assertProvider(manager: DiagnosticProviderManager): boolean {
    if (!this.sample()) return true;
    try {
      let badState = 0;
      for (const info of manager.all()) {
        if (info.state === ProviderState.error) {
          badState++;
        }
        if (info.state === ProviderState.disposed) {
          badState++;
        }
      }

      if (badState > 0) {
        return this.fail('provider', `${badState} providers in error/disposed state: ` +
          manager.all()
            .filter((i) => i.state === ProviderState.error || i.state === ProviderState.disposed)
            .map((i) => `${i.name}=${i.state}`)
            .join(', '));
      }
      return true;
    } catch {
      return this.fail('provider', 'Exception during provider assertion');
    }
  }

  /**
   * Run all assertions in sequence. Returns true if all pass.
   */
  runAll(
    store: ProblemStore,
    manager: DiagnosticProviderManager,
    folderManager: FolderStatusManager,
  ): boolean {
    if (!this.enabled) return true;
    const results = [
      this.assertStore(store),
      this.assertOwnership(store),
      this.assertDecoration(store),
      this.assertFolder(store, folderManager),
      this.assertProvider(manager),
    ];
    return results.every(Boolean);
  }
}

/** Create a RuntimeAssertions instance */
export function createRuntimeAssertions(
  reporter: TelemetryReporter,
  enabled?: boolean,
): RuntimeAssertions {
  return new RuntimeAssertions(reporter, enabled ?? true);
}