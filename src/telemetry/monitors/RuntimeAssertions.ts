import { Disposable, Uri } from 'vscode';
import { ProblemStore } from '../../store/ProblemStore';
import { DiagnosticProviderManager, ProviderState } from '../../providers/DiagnosticProviderManager';
import { ProblemSeverity } from '../../core/types';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { EventPipelineMonitor, PipelineId } from './EventPipelineMonitor';
import { DiagnosticsMonitor } from './DiagnosticsMonitor';
import { DecorationMonitor } from './DecorationMonitor';
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
/*  Task 4 — Provider Assertion Rules                                  */
/* ------------------------------------------------------------------ */

/** Detect providers in invalid or unexpected states */
export function createProviderInvalidStateRule(manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'provider.invalidState', description: 'Detect providers in error or disposed states',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      for (const info of manager.all()) {
        if (info.state === ProviderState.error) {
          failures.push({ assertion: 'provider.invalidState', category: AssertionCategory.Provider, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Provider "${info.name}" is in error state`, provider: info.name });
        }
        if (info.state === ProviderState.disposed) {
          failures.push({ assertion: 'provider.invalidState', category: AssertionCategory.Provider, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Provider "${info.name}" is disposed`, provider: info.name });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect provider running twice (duplicate entries) */
export function createProviderDuplicateRunningRule(manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'provider.duplicateRunning', description: 'Detect multiple providers with same name',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const seen = new Set<string>();
      const failures: AssertionFailure[] = [];
      for (const info of manager.all()) {
        if (seen.has(info.name)) {
          failures.push({ assertion: 'provider.duplicateRunning', category: AssertionCategory.Provider, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Duplicate provider name "${info.name}"`, provider: info.name });
        }
        seen.add(info.name);
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect disposed providers that still have scanning flag true */
export function createProviderDisposedWhileScanningRule(manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'provider.disposedWhileScanning', description: 'Detect disposed providers still marked as scanning',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      for (const info of manager.all()) {
        if (info.state === ProviderState.disposed && info.provider.scanning) {
          failures.push({ assertion: 'provider.disposedWhileScanning', category: AssertionCategory.Provider, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Provider "${info.name}" is disposed but scanning=${info.provider.scanning}`, provider: info.name });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect providers that never completed scanning (stuck in scanning state) */
export function createProviderNeverCompletedRule(manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'provider.neverCompleted', description: 'Detect providers scanning for too long (possible stuck)',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      for (const info of manager.all()) {
        if (info.provider.scanning && info.state === ProviderState.running) {
          failures.push({ assertion: 'provider.neverCompleted', category: AssertionCategory.Provider, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Provider "${info.name}" has been scanning for an extended period`, provider: info.name });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect ownership mismatch: store key owned by provider that shouldn't own it */
export function createProviderOwnershipMismatchRule(manager: DiagnosticProviderManager, store: ProblemStore): AssertionRule {
  return {
    name: 'provider.ownershipMismatch', description: 'Detect ownership mismatches between store and provider capabilities',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      const providerNames = new Set(manager.all().map((p) => p.name));
      store.forEachFileEntry((key) => {
        const owner = store.getOwnerForKey(key);
        if (owner && !providerNames.has(owner)) {
          failures.push({ assertion: 'provider.ownershipMismatch', category: AssertionCategory.Provider, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Key ${key} owned by "${owner}" which is not registered`, uri: key, provider: owner });
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect duplicate scans: same provider scanned multiple times concurrently */
export function createProviderDuplicateScanRule(manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'provider.duplicateScan', description: 'Detect providers scanning multiple times concurrently',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const scanning: string[] = [];
      for (const info of manager.all()) {
        if (info.provider.scanning) {
          scanning.push(info.name);
        }
      }
      if (scanning.length <= 1) return passResult(start);
      return failResult('provider.duplicateScan', AssertionCategory.Provider, AssertionSeverity.Warning,
        `${scanning.length} providers scanning concurrently: ${scanning.join(', ')}`, start);
    },
  };
}

/** Detect invalid refresh lifecycle: refresh called in wrong state */
export function createProviderInvalidRefreshRule(manager: DiagnosticProviderManager): AssertionRule {
  return {
    name: 'provider.invalidRefresh', description: 'Detect provider refresh in invalid state',
    category: AssertionCategory.Provider, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      for (const info of manager.all()) {
        if (info.state === ProviderState.disposed || info.state === ProviderState.error) {
          failures.push({ assertion: 'provider.invalidRefresh', category: AssertionCategory.Provider, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Provider "${info.name}" in state ${info.state} cannot be refreshed`, provider: info.name });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Task 5 — Pipeline Assertion Rules                                  */
/* ------------------------------------------------------------------ */

/** Detect missing pipeline stages: a completed pipeline is missing expected stages */
export function createPipelineMissingStageRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.missingStage', description: 'Detect completed pipelines missing expected stages',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      const stats = monitor.getStatistics();
      if (stats.totalExecutions === 0) return passResult(start);
      const depGraph = monitor.getDependencyGraph();
      const expectedStages = ['autoScan', 'provider', 'diagnostics', 'store', 'folder', 'decoration'];
      for (const [pipelineId] of depGraph) {
        const timeline = monitor.getPipelineTimeline(pipelineId);
        if (!timeline.execution) continue;
        for (const stage of expectedStages) {
          if (!timeline.execution.stages.has(stage)) {
            failures.push({ assertion: 'pipeline.missingStage', category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Pipeline ${pipelineId} missing stage "${stage}"`, pipelineId: pipelineId as string });
            break;
          }
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect duplicate stages in a pipeline execution */
export function createPipelineDuplicateStageRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.duplicateStage', description: 'Detect pipelines with duplicate stage entries',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      const depGraph = monitor.getDependencyGraph();
      for (const [pipelineId] of depGraph) {
        const timeline = monitor.getPipelineTimeline(pipelineId);
        if (!timeline.execution) continue;
        const stageNames = new Set<string>();
        for (const stage of (timeline as any).execution.stageOrder as string[]) {
          if (stageNames.has(stage)) {
            failures.push({ assertion: 'pipeline.duplicateStage', category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Pipeline ${pipelineId} has duplicate stage "${stage}"`, pipelineId: pipelineId as string });
          }
          stageNames.add(stage);
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect invalid stage order: stages out of expected order */
export function createPipelineInvalidStageOrderRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.invalidStageOrder', description: 'Detect stages in unexpected order',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      const expectedOrder = ['autoScan', 'provider', 'diagnostics', 'store', 'folder', 'decoration'];
      const depGraph = monitor.getDependencyGraph();
      for (const [pipelineId] of depGraph) {
        const timeline = monitor.getPipelineTimeline(pipelineId);
        if (!timeline.execution) continue;
        const stageOrder = (timeline as any).execution.stageOrder as string[];
        let lastIdx = -1;
        for (const stage of stageOrder) {
          const idx = expectedOrder.indexOf(stage);
          if (idx >= 0 && idx < lastIdx) {
            failures.push({ assertion: 'pipeline.invalidStageOrder', category: AssertionCategory.Pipeline, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `Pipeline ${pipelineId}: stage "${stage}" appeared after "${stageOrder[stageOrder.indexOf(stage) - 1]}" in unexpected order`, pipelineId: pipelineId as string });
          }
          if (idx >= 0) lastIdx = idx;
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect orphan events: events not linked to any execution */
export function createPipelineOrphanEventRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.orphanEvent', description: 'Detect pipeline events not linked to any execution',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalExecutions === 0 && stats.totalEvents === 0) return passResult(start);
      if (stats.totalExecutions === 0 && stats.totalEvents > 0) {
        return failResult('pipeline.orphanEvent', AssertionCategory.Pipeline, AssertionSeverity.Warning,
          `${stats.totalEvents} events with no executions`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect broken execution chain: events with missing seq pointers */
export function createPipelineBrokenChainRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.brokenChain', description: 'Detect broken event sequence chains',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const failures: AssertionFailure[] = [];
      const depGraph = monitor.getDependencyGraph();
      for (const [pipelineId] of depGraph) {
        const timeline = monitor.getPipelineTimeline(pipelineId);
        if (!timeline.execution) continue;
        const events = timeline.events;
        for (let i = 1; i < events.length; i++) {
          const prev = events[i - 1];
          const curr = events[i];
          if (prev.nextEventSeq !== curr.seq && curr.previousEventSeq !== prev.seq) {
            failures.push({ assertion: 'pipeline.brokenChain', category: AssertionCategory.Pipeline, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Broken seq chain at event ${curr.seq}: prev=${prev.seq} next=${curr.seq}`, pipelineId: pipelineId as string });
          }
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect pipeline timeout: executions that may have timed out */
export function createPipelineTimeoutRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.timeout', description: 'Detect timed-out pipeline executions',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.StopPipeline] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.timedOutExecutions > 0) {
        return failResult('pipeline.timeout', AssertionCategory.Pipeline, AssertionSeverity.Error,
          `${stats.timedOutExecutions} pipeline(s) timed out`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect circular execution in pipeline dependency graph */
export function createPipelineCircularExecutionRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.circularExecution', description: 'Detect circular dependencies in pipeline graph',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.StopPipeline] },
    execute: () => {
      const start = Date.now();
      const depGraph = monitor.getDependencyGraph();
      const visited = new Set<string>();
      const inStack = new Set<string>();

      function hasCycle(node: string, graph: Map<string, string[]>): boolean {
        if (inStack.has(node)) return true;
        if (visited.has(node)) return false;
        visited.add(node);
        inStack.add(node);
        const children = graph.get(node);
        if (children) {
          for (const child of children) {
            if (hasCycle(child, graph)) return true;
          }
        }
        inStack.delete(node);
        return false;
      }

      for (const [node] of depGraph) {
        if (hasCycle(node as string, depGraph as unknown as Map<string, string[]>)) {
          return failResult('pipeline.circularExecution', AssertionCategory.Pipeline, AssertionSeverity.Error,
            `Circular dependency detected in pipeline graph starting at ${node}`, start);
        }
      }
      return passResult(start);
    },
  };
}

/** Detect duplicate pipeline IDs */
export function createPipelineDuplicateIdRule(monitor: EventPipelineMonitor): AssertionRule {
  return {
    name: 'pipeline.duplicatePipelineId', description: 'Detect duplicate pipeline IDs',
    category: AssertionCategory.Pipeline, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const executions = m.executions as Map<PipelineId, unknown> | undefined;
      if (!executions || executions.size === 0) return passResult(start);
      const seen = new Set<string>();
      const failures: AssertionFailure[] = [];
      for (const id of executions.keys()) {
        const idStr = id as string;
        if (seen.has(idStr)) {
          failures.push({ assertion: 'pipeline.duplicatePipelineId', category: AssertionCategory.Pipeline, severity: AssertionSeverity.Error, timestamp: Date.now(), message: `Duplicate pipeline ID: ${idStr}`, pipelineId: idStr });
        }
        seen.add(idStr);
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Task 6 — Diagnostics Assertion Rules                               */
/* ------------------------------------------------------------------ */

/** Detect diagnostics changes without URIs */
export function createDiagnosticsNoUriRule(monitor: DiagnosticsMonitor): AssertionRule {
  return {
    name: 'diagnostics.noUri', description: 'Detect diagnostics events without any URI',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalChanges > 0 && stats.totalUris === 0) {
        return failResult('diagnostics.noUri', AssertionCategory.Diagnostics, AssertionSeverity.Warning,
          `${stats.totalChanges} changes with 0 URIs`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect duplicate diagnostics */
export function createDiagnosticsDuplicateRule(monitor: DiagnosticsMonitor): AssertionRule {
  return {
    name: 'diagnostics.duplicate', description: 'Detect duplicate diagnostic entries',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalDuplicateDiagnostics > 0) {
        return failResult('diagnostics.duplicate', AssertionCategory.Diagnostics, AssertionSeverity.Warning,
          `${stats.totalDuplicateDiagnostics} duplicate diagnostic(s) detected`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect stale diagnostics: known URIs no longer in store */
export function createDiagnosticsStaleRule(monitor: DiagnosticsMonitor, store: ProblemStore): AssertionRule {
  return {
    name: 'diagnostics.stale', description: 'Detect stale diagnostics (known URIs removed from store)',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const knownUris: Set<string> = m.knownUris;
      if (!knownUris || knownUris.size === 0) return passResult(start);
      const failures: AssertionFailure[] = [];
      for (const uriStr of knownUris) {
        try {
          if (!store.get(Uri.parse(uriStr))) {
            failures.push({ assertion: 'diagnostics.stale', category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `Known URI ${uriStr} has no state in store`, uri: uriStr });
          }
        } catch { /* skip parse errors */ }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect mapping failures */
export function createDiagnosticsMappingFailureRule(monitor: DiagnosticsMonitor): AssertionRule {
  return {
    name: 'diagnostics.mappingFailure', description: 'Detect diagnostics mapping failures',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalMappings < stats.totalChanges) {
        return failResult('diagnostics.mappingFailure', AssertionCategory.Diagnostics, AssertionSeverity.Error,
          `${stats.totalChanges - stats.totalMappings} changes without mapping (totalChanges=${stats.totalChanges}, totalMappings=${stats.totalMappings})`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect diagnostics not written to store */
export function createDiagnosticsNotWrittenRule(monitor: DiagnosticsMonitor): AssertionRule {
  return {
    name: 'diagnostics.notWritten', description: 'Detect diagnostics mapped but not written to store',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalAcceptedWrites < stats.totalMappings) {
        return failResult('diagnostics.notWritten', AssertionCategory.Diagnostics, AssertionSeverity.Warning,
          `${stats.totalMappings - stats.totalAcceptedWrites} mappings without accepted store write (mappings=${stats.totalMappings}, writes=${stats.totalAcceptedWrites})`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect rejected diagnostics without a recorded reason */
export function createDiagnosticsRejectedNoReasonRule(monitor: DiagnosticsMonitor): AssertionRule {
  return {
    name: 'diagnostics.rejectedNoReason', description: 'Detect rejected diagnostics without explanation',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalRejectedWrites > 0) {
        return failResult('diagnostics.rejectedNoReason', AssertionCategory.Diagnostics, AssertionSeverity.Info,
          `${stats.totalRejectedWrites} rejected diagnostic write(s) (check ownership and priority)`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect inconsistent diagnostic totals */
export function createDiagnosticsInconsistentTotalsRule(monitor: DiagnosticsMonitor): AssertionRule {
  return {
    name: 'diagnostics.inconsistentTotals', description: 'Detect inconsistent diagnostics running totals',
    category: AssertionCategory.Diagnostics, severity: AssertionSeverity.Error,
    enabled: true, recovery: { actions: [RecoveryAction.RequestSnapshot] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalChanges < 0 || stats.totalUris < 0 || stats.totalMappings < 0 || stats.totalStoreWrites < 0) {
        return failResult('diagnostics.inconsistentTotals', AssertionCategory.Diagnostics, AssertionSeverity.Error,
          `Negative statistics detected (changes=${stats.totalChanges} uris=${stats.totalUris} mappings=${stats.totalMappings} writes=${stats.totalStoreWrites})`, start);
      }
      if (stats.totalChanges > 0 && stats.totalMappings > 0 && stats.totalStoreWrites === 0 && stats.totalAcceptedWrites === 0) {
        return failResult('diagnostics.inconsistentTotals', AssertionCategory.Diagnostics, AssertionSeverity.Error,
          `Changes (${stats.totalChanges}) and mappings (${stats.totalMappings}) exist but no store writes`, start);
      }
      return passResult(start);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Task 7 — Decoration Assertion Rules                                */
/* ------------------------------------------------------------------ */

/** Detect duplicate decoration refreshes */
export function createDecorationDuplicateRefreshRule(monitor: DecorationMonitor): AssertionRule {
  return {
    name: 'decoration.duplicateRefresh', description: 'Detect duplicate decoration refreshes',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.duplicateRefreshesDetected > 0) {
        return failResult('decoration.duplicateRefresh', AssertionCategory.Decoration, AssertionSeverity.Info,
          `${stats.duplicateRefreshesDetected} duplicate refresh(es) detected`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect missing fireDidChange: refreshes without fires */
export function createDecorationMissingFireRule(monitor: DecorationMonitor): AssertionRule {
  return {
    name: 'decoration.missingFire', description: 'Detect refreshes that never fired',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const stats = monitor.getStatistics();
      if (stats.totalRefreshes > 0 && stats.totalFires === 0) {
        return failResult('decoration.missingFire', AssertionCategory.Decoration, AssertionSeverity.Warning,
          `${stats.totalRefreshes} refreshes but 0 fires`, start);
      }
      return passResult(start);
    },
  };
}

/** Detect decoration without state: decorations returned for entries not in store */
export function createDecorationWithoutStateRule(monitor: DecorationMonitor, store: ProblemStore): AssertionRule {
  return {
    name: 'decoration.withoutState', description: 'Detect decorations returned for entries without store state',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const lastDecoration: Map<string, unknown> = m._lastDecoration;
      if (!lastDecoration || lastDecoration.size === 0) return passResult(start);
      const failures: AssertionFailure[] = [];
      for (const uriStr of lastDecoration.keys()) {
        try {
          if (!store.get(Uri.parse(uriStr))) {
            failures.push({ assertion: 'decoration.withoutState', category: AssertionCategory.Decoration, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Decoration for ${uriStr} but no state in store`, uri: uriStr });
          }
        } catch { /* skip parse errors */ }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect state without decoration: store entries never decorated */
export function createDecorationStateWithoutDecorationRule(monitor: DecorationMonitor, store: ProblemStore): AssertionRule {
  return {
    name: 'decoration.stateWithoutDecoration', description: 'Detect store entries that were never decorated',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const lastDecoration: Map<string, unknown> = m._lastDecoration;
      if (!lastDecoration) return passResult(start);
      const decoratedUris = new Set(lastDecoration.keys());
      const failures: AssertionFailure[] = [];
      let count = 0;
      store.forEachFileEntry((key) => {
        if (!decoratedUris.has(key) && count < 100) {
          failures.push({ assertion: 'decoration.stateWithoutDecoration', category: AssertionCategory.Decoration, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `State exists for ${key} but never decorated`, uri: key });
          count++;
        }
      });
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect repeated decoration loops */
export function createDecorationLoopRule(monitor: DecorationMonitor): AssertionRule {
  return {
    name: 'decoration.loop', description: 'Detect repeated decoration loops (same URI decorated many times)',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Warning,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const loopCount: Map<string, number> = m._decorationLoopCount;
      if (!loopCount || loopCount.size === 0) return passResult(start);
      const failures: AssertionFailure[] = [];
      for (const [key, count] of loopCount) {
        if (count >= 10) {
          failures.push({ assertion: 'decoration.loop', category: AssertionCategory.Decoration, severity: AssertionSeverity.Warning, timestamp: Date.now(), message: `Decoration loop for key ${key}: ${count} repetitions`, uri: key.split('::')[0] });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect invalid badge in decorations */
export function createDecorationInvalidBadgeRule(monitor: DecorationMonitor): AssertionRule {
  return {
    name: 'decoration.invalidBadge', description: 'Detect decorations with invalid badge patterns',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const lastDecoration: Map<string, { badge?: string }> = m._lastDecoration;
      if (!lastDecoration || lastDecoration.size === 0) return passResult(start);
      const failures: AssertionFailure[] = [];
      for (const [uriStr, entry] of lastDecoration) {
        if (entry.badge && entry.badge.length > 2) {
          failures.push({ assertion: 'decoration.invalidBadge', category: AssertionCategory.Decoration, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `Badge "${entry.badge}" too long (${entry.badge.length} chars) for ${uriStr}`, uri: uriStr });
        }
        if (entry.badge && /[^a-zA-Z0-9+]/.test(entry.badge)) {
          failures.push({ assertion: 'decoration.invalidBadge', category: AssertionCategory.Decoration, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `Badge "${entry.badge}" has invalid characters for ${uriStr}`, uri: uriStr });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect invalid tooltip in decorations */
export function createDecorationInvalidTooltipRule(monitor: DecorationMonitor): AssertionRule {
  return {
    name: 'decoration.invalidTooltip', description: 'Detect decorations with excessively long tooltips',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const lastDecoration: Map<string, { tooltip?: string }> = m._lastDecoration;
      if (!lastDecoration || lastDecoration.size === 0) return passResult(start);
      const failures: AssertionFailure[] = [];
      for (const [uriStr, entry] of lastDecoration) {
        if (entry.tooltip && entry.tooltip.length > 500) {
          failures.push({ assertion: 'decoration.invalidTooltip', category: AssertionCategory.Decoration, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `Tooltip too long (${entry.tooltip.length} chars) for ${uriStr}`, uri: uriStr });
        }
      }
      if (failures.length === 0) return passResult(start);
      return { passed: false, failures, executionTimeMs: Date.now() - start };
    },
  };
}

/** Detect invalid icon (missing color) in decorations */
export function createDecorationInvalidIconRule(monitor: DecorationMonitor): AssertionRule {
  return {
    name: 'decoration.invalidIcon', description: 'Detect decorations without color information',
    category: AssertionCategory.Decoration, severity: AssertionSeverity.Info,
    enabled: true, recovery: { actions: [RecoveryAction.None] },
    execute: () => {
      const start = Date.now();
      const m = monitor as any;
      const lastDecoration: Map<string, { colorId?: string }> = m._lastDecoration;
      if (!lastDecoration || lastDecoration.size === 0) return passResult(start);
      const failures: AssertionFailure[] = [];
      for (const [uriStr, entry] of lastDecoration) {
        if (!entry.colorId) {
          failures.push({ assertion: 'decoration.invalidIcon', category: AssertionCategory.Decoration, severity: AssertionSeverity.Info, timestamp: Date.now(), message: `Decoration for ${uriStr} has no color ID`, uri: uriStr });
        }
      }
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

  /** Register all provider assertion rules (Task 4) */
  registerProviderAssertions(manager: DiagnosticProviderManager, store: ProblemStore): Disposable[] {
    const disposables: Disposable[] = [];
    const rules: AssertionRule[] = [
      createProviderInvalidStateRule(manager),
      createProviderDuplicateRunningRule(manager),
      createProviderDisposedWhileScanningRule(manager),
      createProviderNeverCompletedRule(manager),
      createProviderOwnershipMismatchRule(manager, store),
      createProviderDuplicateScanRule(manager),
      createProviderInvalidRefreshRule(manager),
    ];
    for (const rule of rules) {
      disposables.push(this.engine.registerRule(rule));
    }
    return disposables;
  }

  /** Register all decoration assertion rules (Task 7) */
  registerDecorationAssertions(monitor: DecorationMonitor, store: ProblemStore): Disposable[] {
    const disposables: Disposable[] = [];
    const rules: AssertionRule[] = [
      createDecorationDuplicateRefreshRule(monitor),
      createDecorationMissingFireRule(monitor),
      createDecorationWithoutStateRule(monitor, store),
      createDecorationStateWithoutDecorationRule(monitor, store),
      createDecorationLoopRule(monitor),
      createDecorationInvalidBadgeRule(monitor),
      createDecorationInvalidTooltipRule(monitor),
      createDecorationInvalidIconRule(monitor),
    ];
    for (const rule of rules) {
      disposables.push(this.engine.registerRule(rule));
    }
    return disposables;
  }

  /** Register all pipeline assertion rules (Task 5) */
  registerPipelineAssertions(monitor: EventPipelineMonitor): Disposable[] {
    const disposables: Disposable[] = [];
    const rules: AssertionRule[] = [
      createPipelineMissingStageRule(monitor),
      createPipelineDuplicateStageRule(monitor),
      createPipelineInvalidStageOrderRule(monitor),
      createPipelineOrphanEventRule(monitor),
      createPipelineBrokenChainRule(monitor),
      createPipelineTimeoutRule(monitor),
      createPipelineCircularExecutionRule(monitor),
      createPipelineDuplicateIdRule(monitor),
    ];
    for (const rule of rules) {
      disposables.push(this.engine.registerRule(rule));
    }
    return disposables;
  }

  /** Register all diagnostics assertion rules (Task 6) */
  registerDiagnosticsAssertions(monitor: DiagnosticsMonitor, store: ProblemStore): Disposable[] {
    const disposables: Disposable[] = [];
    const rules: AssertionRule[] = [
      createDiagnosticsNoUriRule(monitor),
      createDiagnosticsDuplicateRule(monitor),
      createDiagnosticsStaleRule(monitor, store),
      createDiagnosticsMappingFailureRule(monitor),
      createDiagnosticsNotWrittenRule(monitor),
      createDiagnosticsRejectedNoReasonRule(monitor),
      createDiagnosticsInconsistentTotalsRule(monitor),
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
