import { Disposable } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { ProblemSeverity } from '../../core/types';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetryEvent, TraceId } from '../../telemetry/TelemetryEvent';
import { generateTraceId } from '../../telemetry/TelemetryConfig';

/* ------------------------------------------------------------------ */
/*  Assertion Severity & Category                                      */
/* ------------------------------------------------------------------ */

export enum AssertionSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export enum AssertionCategory {
  Store = 'store',
  Provider = 'provider',
  Pipeline = 'pipeline',
  Diagnostics = 'diagnostics',
  Decoration = 'decoration',
  Folder = 'folder',
}

/* ------------------------------------------------------------------ */
/*  Recovery Policy                                                    */
/* ------------------------------------------------------------------ */

export enum RecoveryAction {
  None = 'none',
  WarningOnly = 'warningOnly',
  AutoRecover = 'autoRecover',
  StopPipeline = 'stopPipeline',
  RequestSnapshot = 'requestSnapshot',
  RequestTimeline = 'requestTimeline',
  NotifyDashboard = 'notifyDashboard',
}

export interface RecoveryPolicy {
  readonly actions: RecoveryAction[];
}

/* ------------------------------------------------------------------ */
/*  AssertionRule                                                      */
/* ------------------------------------------------------------------ */

export interface AssertionContext {
  readonly reporter: TelemetryReporter;
  readonly engine: AssertionEngine;
}

export interface AssertionRule {
  readonly name: string;
  readonly description: string;
  readonly category: AssertionCategory;
  readonly severity: AssertionSeverity;
  enabled: boolean;
  readonly recovery: RecoveryPolicy;
  execute(context: AssertionContext): AssertionResult | Promise<AssertionResult>;
}

/* ------------------------------------------------------------------ */
/*  AssertionResult & Failure                                          */
/* ------------------------------------------------------------------ */

export interface AssertionResult {
  readonly passed: boolean;
  readonly failures: AssertionFailure[];
  readonly executionTimeMs: number;
}

export interface AssertionFailure {
  readonly assertion: string;
  readonly category: AssertionCategory;
  readonly severity: AssertionSeverity;
  readonly timestamp: number;
  readonly message: string;
  readonly uri?: string;
  readonly provider?: string;
  readonly pipelineId?: string;
  readonly stackTrace?: string;
  readonly relatedEvents?: TelemetryEvent[];
  readonly relatedData?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  AssertionStatistics                                                */
/* ------------------------------------------------------------------ */

export interface CategoryFailureCount {
  readonly category: AssertionCategory;
  readonly count: number;
}

export interface ProviderFailureCount {
  readonly provider: string;
  readonly count: number;
}

export interface MonitorFailureCount {
  readonly monitor: string;
  readonly count: number;
}

export interface UriFailureCount {
  readonly uri: string;
  readonly count: number;
}

export interface AssertionStatistics {
  readonly assertionsExecuted: number;
  readonly assertionsPassed: number;
  readonly assertionsFailed: number;
  readonly failuresByCategory: CategoryFailureCount[];
  readonly failuresByProvider: ProviderFailureCount[];
  readonly failuresByMonitor: MonitorFailureCount[];
  readonly failuresByUri: UriFailureCount[];
  readonly mostFrequentAssertion: string;
  readonly mostFrequentAssertionCount: number;
  readonly totalExecutionTimeMs: number;
  readonly averageExecutionTimeMs: number;
  readonly peakExecutionTimeMs: number;
}

/* ------------------------------------------------------------------ */
/*  AssertionEngine                                                    */
/* ------------------------------------------------------------------ */

export interface AssertionEngine {
  registerRule(rule: AssertionRule): Disposable;
  unregisterRule(name: string): boolean;
  enableRule(name: string): boolean;
  disableRule(name: string): boolean;
  getRule(name: string): AssertionRule | undefined;
  getAllRules(): AssertionRule[];
  executeRule(name: string): Promise<AssertionResult>;
  executeAll(): Promise<AssertionResult[]>;
  getStatistics(): AssertionStatistics;
  getFailures(): AssertionFailure[];
  clearFailures(): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  EngineEventData                                                    */
/* ------------------------------------------------------------------ */

export interface AssertionEngineEventData {
  readonly type: 'assertion.execution';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'RuntimeAssertions';
  readonly rule: string;
  readonly category: AssertionCategory;
  readonly severity: AssertionSeverity;
  readonly passed: boolean;
  readonly failureCount: number;
  readonly executionTimeMs: number;
}

export interface AssertionEngineFailureEventData {
  readonly type: 'assertion.failure';
  readonly timestamp: number;
  readonly traceId: TraceId;
  readonly source: 'RuntimeAssertions';
  readonly rule: string;
  readonly category: AssertionCategory;
  readonly severity: AssertionSeverity;
  readonly message: string;
  readonly uri?: string;
  readonly provider?: string;
  readonly pipelineId?: string;
}

export type RuntimeAssertionMonitorEvent = AssertionEngineEventData | AssertionEngineFailureEventData;

/* ------------------------------------------------------------------ */
/*  Default Implementation                                             */
/* ------------------------------------------------------------------ */

class DefaultAssertionEngine implements AssertionEngine, Disposable {
  private readonly rules = new Map<string, AssertionRule>();
  private readonly failures: AssertionFailure[] = [];
  private disposed = false;

  private totalExecuted = 0;
  private totalPassed = 0;
  private totalFailed = 0;
  private totalExecutionTimeMs = 0;
  private peakExecutionTimeMs = 0;

  private readonly failureCategoryCount = new Map<AssertionCategory, number>();
  private readonly failureProviderCount = new Map<string, number>();
  private readonly failureMonitorCount = new Map<string, number>();
  private readonly failureUriCount = new Map<string, number>();
  private readonly assertionFrequency = new Map<string, number>();

  private readonly maxStoredFailures = 10000;

  constructor(private readonly reporter: TelemetryReporter) {}

  registerRule(rule: AssertionRule): Disposable {
    this.rules.set(rule.name, rule);
    return { dispose: () => this.rules.delete(rule.name) };
  }

  unregisterRule(name: string): boolean {
    return this.rules.delete(name);
  }

  enableRule(name: string): boolean {
    const rule = this.rules.get(name);
    if (!rule) return false;
    rule.enabled = true;
    return true;
  }

  disableRule(name: string): boolean {
    const rule = this.rules.get(name);
    if (!rule) return false;
    rule.enabled = false;
    return true;
  }

  getRule(name: string): AssertionRule | undefined {
    return this.rules.get(name);
  }

  getAllRules(): AssertionRule[] {
    return [...this.rules.values()];
  }

  async executeRule(name: string): Promise<AssertionResult> {
    const rule = this.rules.get(name);
    if (!rule) {
      return {
        passed: false,
        failures: [{
          assertion: name,
          category: AssertionCategory.Diagnostics,
          severity: AssertionSeverity.Error,
          timestamp: Date.now(),
          message: `Rule "${name}" not found`,
        }],
        executionTimeMs: 0,
      };
    }
    if (!rule.enabled) {
      return { passed: true, failures: [], executionTimeMs: 0 };
    }
    return this.runRule(rule);
  }

  async executeAll(): Promise<AssertionResult[]> {
    const results: AssertionResult[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      results.push(await this.runRule(rule));
    }
    return results;
  }

  private async runRule(rule: AssertionRule): Promise<AssertionResult> {
    const start = Date.now();
    const context: AssertionContext = { reporter: this.reporter, engine: this };
    let result: AssertionResult;

    try {
      result = await rule.execute(context);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = {
        passed: false,
        failures: [{
          assertion: rule.name,
          category: rule.category,
          severity: AssertionSeverity.Error,
          timestamp: Date.now(),
          message: `Exception: ${msg}`,
          stackTrace: e instanceof Error ? e.stack : undefined,
        }],
        executionTimeMs: Date.now() - start,
      };
    }

    const elapsed = Date.now() - start;
    this.totalExecuted++;
    this.totalExecutionTimeMs += elapsed;
    if (elapsed > this.peakExecutionTimeMs) this.peakExecutionTimeMs = elapsed;

    const freq = this.assertionFrequency.get(rule.name) ?? 0;
    this.assertionFrequency.set(rule.name, freq + 1);

    if (result.passed) {
      this.totalPassed++;
      this.reporter.report({
        type: 'assertion.execution',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'RuntimeAssertions',
        rule: rule.name,
        category: rule.category,
        severity: rule.severity,
        passed: true,
        failureCount: 0,
        executionTimeMs: result.executionTimeMs,
      } as TelemetryEvent);
      return result;
    }

    this.totalFailed++;
    this.reporter.report({
      type: 'assertion.execution',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'RuntimeAssertions',
      rule: rule.name,
      category: rule.category,
      severity: rule.severity,
      passed: false,
      failureCount: result.failures.length,
      executionTimeMs: result.executionTimeMs,
    } as TelemetryEvent);

    for (const f of result.failures) {
      this.storeFailure(f);
      this.reporter.report({
        type: 'assertion.failure',
        timestamp: f.timestamp,
        traceId: generateTraceId(),
        source: 'RuntimeAssertions',
        rule: rule.name,
        category: rule.category,
        severity: rule.severity,
        message: f.message,
        uri: f.uri,
        provider: f.provider,
        pipelineId: f.pipelineId,
      } as TelemetryEvent);
    }

    return result;
  }

  private storeFailure(failure: AssertionFailure): void {
    if (this.failures.length >= this.maxStoredFailures) {
      this.failures.shift();
    }
    this.failures.push(failure);

    this.failureCategoryCount.set(
      failure.category,
      (this.failureCategoryCount.get(failure.category) ?? 0) + 1,
    );
    if (failure.provider) {
      this.failureProviderCount.set(
        failure.provider,
        (this.failureProviderCount.get(failure.provider) ?? 0) + 1,
      );
    }
    if (failure.uri) {
      this.failureUriCount.set(
        failure.uri,
        (this.failureUriCount.get(failure.uri) ?? 0) + 1,
      );
    }
  }

  getStatistics(): AssertionStatistics {
    const sortedFreq = [...this.assertionFrequency.entries()].sort((a, b) => b[1] - a[1]);
    const mostFreq = sortedFreq[0];

    return {
      assertionsExecuted: this.totalExecuted,
      assertionsPassed: this.totalPassed,
      assertionsFailed: this.totalFailed,
      failuresByCategory: [...this.failureCategoryCount.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      failuresByProvider: [...this.failureProviderCount.entries()]
        .map(([provider, count]) => ({ provider, count }))
        .sort((a, b) => b.count - a.count),
      failuresByMonitor: [...this.failureMonitorCount.entries()]
        .map(([monitor, count]) => ({ monitor, count }))
        .sort((a, b) => b.count - a.count),
      failuresByUri: [...this.failureUriCount.entries()]
        .map(([uri, count]) => ({ uri, count }))
        .sort((a, b) => b.count - a.count),
      mostFrequentAssertion: mostFreq ? mostFreq[0] : '',
      mostFrequentAssertionCount: mostFreq ? mostFreq[1] : 0,
      totalExecutionTimeMs: this.totalExecutionTimeMs,
      averageExecutionTimeMs: this.totalExecuted > 0
        ? Math.round(this.totalExecutionTimeMs / this.totalExecuted) : 0,
      peakExecutionTimeMs: this.peakExecutionTimeMs,
    };
  }

  getFailures(): AssertionFailure[] {
    return [...this.failures];
  }

  clearFailures(): void {
    this.failures.length = 0;
    this.failureCategoryCount.clear();
    this.failureProviderCount.clear();
    this.failureMonitorCount.clear();
    this.failureUriCount.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rules.clear();
    this.failures.length = 0;
    this.failureCategoryCount.clear();
    this.failureProviderCount.clear();
    this.failureMonitorCount.clear();
    this.failureUriCount.clear();
    this.assertionFrequency.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: build a single-failure AssertionResult                     */
/* ------------------------------------------------------------------ */

function failResult(
  rule: string, category: AssertionCategory, severity: AssertionSeverity,
  message: string, startTime: number, uri?: string, provider?: string,
): AssertionResult {
  return {
    passed: false,
    failures: [{
      assertion: rule, category, severity, timestamp: Date.now(),
      message, uri, provider,
    }],
    executionTimeMs: Date.now() - startTime,
  };
}

function passResult(startTime: number): AssertionResult {
  return { passed: true, failures: [], executionTimeMs: Date.now() - startTime };
}

/* ------------------------------------------------------------------ */
/*  Task 3 — Store Assertion Rules                                     */
/* ------------------------------------------------------------------ */

/** Detect entries with negative error/warning/info counts */
export function createStoreNegativeCountsRule(store: ProblemStore): AssertionRule {
  return {
    name: 'store.negativeCounts', description: 'Detect negative error/warning/info counts',
    category: AssertionCategory.Store, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      store.forEachEntry((key, state) => {
        if (state.errorCount < 0) {
          failures.push({ assertion: 'store.negativeCounts', category: AssertionCategory.Store, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Negative errorCount=${state.errorCount} for key=${key}`, uri: key });
        }
        if (state.warningCount < 0) {
          failures.push({ assertion: 'store.negativeCounts', category: AssertionCategory.Store, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Negative warningCount=${state.warningCount} for key=${key}`, uri: key });
        }
        if (state.infoCount < 0) {
          failures.push({ assertion: 'store.negativeCounts', category: AssertionCategory.Store, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Negative infoCount=${state.infoCount} for key=${key}`, uri: key });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect severity values outside valid range (0-3) */
export function createStoreInvalidSeverityRule(store: ProblemStore): AssertionRule {
  return {
    name: 'store.invalidSeverity', description: 'Detect severity values outside valid range 0–3',
    category: AssertionCategory.Store, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      store.forEachEntry((key, state) => {
        const s = state.severity;
        if (s < ProblemSeverity.None || s > ProblemSeverity.Error) {
          failures.push({ assertion: 'store.invalidSeverity', category: AssertionCategory.Store, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Invalid severity=${s} for key=${key} (expected 0–3)`, uri: key });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect impossible ProblemState: severity doesn't match actual counts */
export function createStoreImpossibleStateRule(store: ProblemStore): AssertionRule {
  return {
    name: 'store.impossibleState', description: 'Detect severity/count mismatch (e.g. Error severity with 0 errors)',
    category: AssertionCategory.Store, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      store.forEachEntry((key, state) => {
        if (state.severity >= ProblemSeverity.Error && state.errorCount === 0 && state.warningCount === 0 && state.infoCount === 0) {
          failures.push({ assertion: 'store.impossibleState', category: AssertionCategory.Store, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Severity=Error but all counts are 0 for key=${key}`, uri: key });
        }
        if (state.severity === ProblemSeverity.None && (state.errorCount > 0 || state.warningCount > 0 || state.infoCount > 0)) {
          failures.push({ assertion: 'store.impossibleState', category: AssertionCategory.Store, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Severity=None but counts>0 (e=${state.errorCount} w=${state.warningCount} i=${state.infoCount}) for key=${key}`, uri: key });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Verify that running totals match manual computation */
export function createStoreInconsistentTotalsRule(store: ProblemStore): AssertionRule {
  return {
    name: 'store.inconsistentTotals', description: 'Verify running totals match manual computation',
    category: AssertionCategory.Store, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.RequestSnapshot] },
    execute: () => {
      const start = Date.now();
      let computedErrors = 0, computedWarnings = 0, computedInfos = 0, computedFiles = 0;
      store.forEachFileEntry((_key, state) => {
        computedErrors += state.errorCount;
        computedWarnings += state.warningCount;
        computedInfos += state.infoCount;
        computedFiles += 1;
      });
      const totals = store.computeTotals();
      const messages: string[] = [];
      if (totals.errorCount !== computedErrors) messages.push(`errorCount: store=${totals.errorCount} computed=${computedErrors}`);
      if (totals.warningCount !== computedWarnings) messages.push(`warningCount: store=${totals.warningCount} computed=${computedWarnings}`);
      if (totals.infoCount !== computedInfos) messages.push(`infoCount: store=${totals.infoCount} computed=${computedInfos}`);
      if (totals.fileCount !== computedFiles) messages.push(`fileCount: store=${totals.fileCount} computed=${computedFiles}`);
      if (messages.length === 0) return passResult(start);
      return failResult('store.inconsistentTotals', AssertionCategory.Store, AssertionSeverity.Error, messages.join('; '), start);
    },
  };
}

/** Detect orphan ownership: owner references non-existent provider */
export function createStoreOrphanOwnershipRule(store: ProblemStore, manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'store.orphanOwnership', description: 'Detect keys whose owner is not a registered provider',
    category: AssertionCategory.Store, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const providerNames = new Set(manager.all().map((p) => p.name));
      const failures: AssertionFailure[] = [];
      const seen = new Set<string>();
      store.forEachFileEntry((key) => {
        const owner = store.getOwnerForKey(key);
        if (owner && !providerNames.has(owner) && !seen.has(key)) {
          seen.add(key);
          failures.push({ assertion: 'store.orphanOwnership', category: AssertionCategory.Store, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Key ${key} owned by "${owner}" which is not a registered provider`, uri: key, provider: owner });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect stale ownership: owner is a disposed/unavailable provider */
export function createStoreStaleOwnershipRule(store: ProblemStore, manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'store.staleOwnership', description: 'Detect keys owned by disposed providers',
    category: AssertionCategory.Store, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      store.forEachFileEntry((key) => {
        const owner = store.getOwnerForKey(key);
        if (owner) {
          const info = manager.getInfo(owner);
          if (info && info.state === 'disposed') {
            failures.push({ assertion: 'store.staleOwnership', category: AssertionCategory.Store, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Key ${key} owned by disposed provider "${owner}"`, uri: key, provider: owner });
          }
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect duplicate ownership: keys with multiple conflicting owners */
export function createStoreDuplicateOwnershipRule(store: ProblemStore): AssertionRule {
  return {
    name: 'store.duplicateOwnership', description: 'Detect keys claimed by multiple providers',
    category: AssertionCategory.Store, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const seen = new Map<string, string>();
      const failures: AssertionFailure[] = [];
      store.forEachFileEntry((key) => {
        const owner = store.getOwnerForKey(key);
        if (owner) {
          if (seen.has(key) && seen.get(key) !== owner) {
            failures.push({ assertion: 'store.duplicateOwnership', category: AssertionCategory.Store, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Key ${key} has conflicting owners: "${seen.get(key)}" and "${owner}"`, uri: key, provider: owner });
          }
          seen.set(key, owner);
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect invalid folder aggregates */
export function createStoreInvalidFolderAggregateRule(store: ProblemStore): AssertionRule {
  return {
    name: 'store.invalidFolderAggregate', description: 'Detect folder aggregates with negative counts',
    category: AssertionCategory.Store, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      store.forEachEntry((key, state, isFolder) => {
        if (!isFolder) return;
        if (state.errorCount < 0 || state.warningCount < 0 || state.infoCount < 0) {
          failures.push({ assertion: 'store.invalidFolderAggregate', category: AssertionCategory.Store, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Folder aggregate ${key} has negative count (e=${state.errorCount} w=${state.warningCount} i=${state.infoCount})`, uri: key });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect missing providers: store has configured providers that don't exist in manager */
export function createStoreMissingProviderRule(store: ProblemStore, manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'store.missingProvider', description: 'Detect provider priorities for unregistered providers',
    category: AssertionCategory.Store, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const registered = new Set(manager.all().map((p) => p.name));
      const failures: AssertionFailure[] = [];
      store.forEachFileEntry((key) => {
        const owner = store.getOwnerForKey(key);
        if (owner && !registered.has(owner)) {
          failures.push({ assertion: 'store.missingProvider', category: AssertionCategory.Store, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Key ${key} owned by "${owner}" which is not in manager`, uri: key, provider: owner });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  RuntimeAssertions — Main Facade                                    */
/* ------------------------------------------------------------------ */

/**
 * RuntimeAssertions is the automatic guardian of the entire extension.
 *
 * Unlike telemetry monitors, this does not observe behavior — it
 * continuously validates that the system remains in a valid state while
 * the extension is running.
 *
 * Features:
 * - Modular rule engine with register/enable/disable/execute API
 * - Domain-specific assertions for store, provider, pipeline, diagnostics,
 *   decoration, and folder
 * - Configurable recovery policies
 * - Full telemetry on every assertion execution and failure
 * - Comprehensive statistics
 */
export class RuntimeAssertions implements Disposable {
  readonly engine: AssertionEngine;
  private disposed = false;

  constructor(
    reporter: TelemetryReporter,
    private enabled: boolean,
  ) {
    this.engine = new DefaultAssertionEngine(reporter);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Register all store assertion rules (Task 3) */
  registerStoreAssertions(store: ProblemStore, manager: DiagnosticProviderManager): Disposable[] {
    const disposables: Disposable[] = [];
    const rules: AssertionRule[] = [
      createStoreNegativeCountsRule(store),
      createStoreInvalidSeverityRule(store),
      createStoreImpossibleStateRule(store),
      createStoreInconsistentTotalsRule(store),
      createStoreOrphanOwnershipRule(store, manager),
      createStoreStaleOwnershipRule(store, manager),
      createStoreDuplicateOwnershipRule(store),
      createStoreInvalidFolderAggregateRule(store),
      createStoreMissingProviderRule(store, manager),
    ];
    for (const rule of rules) {
      disposables.push(this.engine.registerRule(rule));
    }
    return disposables;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.dispose();
  }
}

/** Create a RuntimeAssertions instance */
export function createRuntimeAssertions(
  reporter: TelemetryReporter,
  enabled?: boolean,
): RuntimeAssertions {
  return new RuntimeAssertions(reporter, enabled ?? true);
}
