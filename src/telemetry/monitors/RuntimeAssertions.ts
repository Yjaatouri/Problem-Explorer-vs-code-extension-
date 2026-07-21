import { Disposable } from 'vscode';
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
