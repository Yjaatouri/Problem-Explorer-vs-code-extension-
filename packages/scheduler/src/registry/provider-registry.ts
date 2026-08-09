// ProviderRegistry — registration, manifest loading, and the health state
// machine (§5.6, §11.1). The scheduler talks to this, never to providers
// by ID. Manifest + explicit registration; never directory scanning.
//
// Health transitions are emitted ONLY on health changes (Ready,
// MissingDependency, Misconfigured, Failed, Unavailable) — the transient
// `Scanning` state is observable via getStatus() but never fired, so the
// cache invalidation path (§7.2) never reacts to scan start/stop.

import { ProviderError, ProviderHealth, SchedulerError, TypedEventEmitter } from '@pe/core';
import type {
  ConfigType,
  HealthResult,
  Provider,
  ProviderStatus,
  ProviderStatusChangeEvent,
} from '@pe/core';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Default retry window for MissingDependency / Failed (§11.1: every 10 min). */
export const HEALTH_CHECK_RETRY_MS = 10 * 60 * 1000;

/** Per health-check timeout (a hung check must not block the event loop). */
export const HEALTH_CHECK_TIMEOUT_MS = 10 * 1000;

export interface ProviderRegistryOptions {
  /** Retry interval for MissingDependency / Failed states (default 10 min). */
  readonly healthCheckRetryMs?: number;
  /** Timeout for one health check (default 10 s). */
  readonly healthCheckTimeoutMs?: number;
  /** Clock for timestamps; injectable for tests. */
  readonly now?: () => number;
}

/** A provider declared in a JSON manifest (§5.6). Scan support arrives in M4. */
interface ManifestShape {
  id: string;
  displayName: string;
  capabilities: Provider['capabilities'];
  configSchema: Provider['configSchema'];
  defaultConfig: Provider['defaultConfig'];
  /** Optional command that proves availability, e.g. ['tsc', '--version']. */
  healthCheckCommand?: readonly string[];
}

export class ProviderRegistry {
  private readonly healthCheckRetryMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly now: () => number;
  private readonly providers = new Map<string, Provider>();
  private readonly statuses = new Map<string, ProviderStatus>();
  private readonly statusEmitter = new TypedEventEmitter<ProviderStatusChangeEvent>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlightChecks = new Set<string>();

  constructor(options: ProviderRegistryOptions = {}) {
    this.healthCheckRetryMs = options.healthCheckRetryMs ?? HEALTH_CHECK_RETRY_MS;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Event: a provider's health state changed (never fires for Scanning). */
  readonly onStatusChanged = this.statusEmitter.on.bind(this.statusEmitter);

  /**
   * Register a provider instance. Duplicate ids are a programming error.
   * A health check is scheduled immediately (Unknown → checked).
   */
  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new SchedulerError(`provider already registered: ${provider.id}`, 'duplicate-provider');
    }
    this.providers.set(provider.id, provider);
    this.statuses.set(provider.id, this.unknownStatus());
    void this.healthCheck(provider.id);
  }

  /**
   * Register a provider from a JSON manifest (metadata + optional
   * healthCheckCommand). Never directory-scans for manifests.
   */
  registerFromManifest(manifestPath: string): Provider {
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch (error) {
      throw new SchedulerError(
        `cannot read provider manifest: ${manifestPath}`,
        'manifest-unreadable',
        { cause: String(error) },
      );
    }
    let manifest: ManifestShape;
    try {
      manifest = JSON.parse(raw) as ManifestShape;
    } catch (error) {
      throw new SchedulerError(`invalid provider manifest: ${manifestPath}`, 'manifest-invalid', {
        cause: String(error),
      });
    }
    if (
      typeof manifest.id !== 'string' ||
      typeof manifest.displayName !== 'string' ||
      !manifest.capabilities ||
      !manifest.configSchema ||
      !manifest.defaultConfig
    ) {
      throw new SchedulerError(
        `manifest missing required fields: ${manifestPath}`,
        'manifest-invalid',
      );
    }
    const provider: Provider = {
      id: manifest.id,
      displayName: manifest.displayName,
      capabilities: manifest.capabilities,
      configSchema: manifest.configSchema,
      defaultConfig: manifest.defaultConfig,
      healthCheck: () => this.checkCommand(manifest.healthCheckCommand),
      scan: () =>
        Promise.reject(
          new ProviderError(
            'manifest providers cannot scan yet — register an explicit provider (M4)',
            manifest.id,
            'scan-not-implemented',
          ),
        ),
    };
    this.register(provider);
    return provider;
  }

  getById(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /** Providers able to handle a capability, sorted by tier desc, then registration order. */
  getByCapability(capability: ConfigType): readonly Provider[] {
    return [...this.providers.values()]
      .filter((provider) => provider.capabilities.supportedConfigTypes.includes(capability))
      .sort((a, b) => b.capabilities.confidenceTier - a.capabilities.confidenceTier);
  }

  all(): readonly Provider[] {
    return [...this.providers.values()];
  }

  getStatus(providerId: string): ProviderStatus | undefined {
    return this.statuses.get(providerId);
  }

  /**
   * Check every provider, isolated: one failing provider never blocks or
   * rejects the others. Returns the status events for changed providers.
   */
  async healthCheckAll(): Promise<readonly ProviderStatusChangeEvent[]> {
    const events: ProviderStatusChangeEvent[] = [];
    for (const provider of this.providers.values()) {
      const event = await this.healthCheck(provider.id);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  /**
   * Run one health check (§11.2). Concurrent checks for the same provider
   * are coalesced — a second call while one is in flight returns nothing.
   */
  async healthCheck(providerId: string): Promise<ProviderStatusChangeEvent | undefined> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new SchedulerError(`unknown provider: ${providerId}`, 'unknown-provider');
    }
    if (this.inFlightChecks.has(providerId)) {
      return undefined;
    }
    this.inFlightChecks.add(providerId);
    try {
      const result = await withTimeout(
        provider.healthCheck(),
        this.healthCheckTimeoutMs,
        'health check timed out',
      );
      return this.applyHealthResult(providerId, result);
    } catch (error) {
      // A throwing check is a Failed health, never a crashed engine.
      return this.applyHealthResult(providerId, {
        health: ProviderHealth.Failed,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlightChecks.delete(providerId);
    }
  }

  /** Called by the scheduler when a scan starts (transient; not emitted). */
  markScanning(providerId: string): void {
    this.setStatus(providerId, { health: ProviderHealth.Scanning, lastCheckMs: this.now() }, false);
  }

  /** Called by the scheduler when a scan finishes. Failure ⇒ Failed (emitted). */
  finishScan(providerId: string, ok: boolean, error?: Error): void {
    if (ok) {
      this.setStatus(
        providerId,
        { health: ProviderHealth.Ready, lastCheckMs: this.now() },
        this.currentHealth(providerId) !== ProviderHealth.Ready,
      );
    } else {
      this.setStatus(
        providerId,
        {
          health: ProviderHealth.Failed,
          lastCheckMs: this.now(),
          message: error?.message,
          lastError: error,
        },
        true,
      );
    }
  }

  /** Drop all providers, timers, and listeners. */
  dispose(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.providers.clear();
    this.statuses.clear();
    this.statusEmitter.clear();
    this.inFlightChecks.clear();
  }

  private unknownStatus(): ProviderStatus {
    return { health: ProviderHealth.Unknown, lastCheckMs: 0 };
  }

  private currentHealth(providerId: string): ProviderHealth {
    return this.statuses.get(providerId)?.health ?? ProviderHealth.Unknown;
  }

  private applyHealthResult(
    providerId: string,
    result: HealthResult,
  ): ProviderStatusChangeEvent | undefined {
    const previous = this.currentHealth(providerId);
    if (result.health === previous) {
      return undefined;
    }
    const status: ProviderStatus = {
      health: result.health,
      ...(result.message !== undefined ? { message: result.message } : {}),
      lastCheckMs: this.now(),
    };
    this.setStatus(providerId, status, true);
    return { providerId, status };
  }

  private setStatus(providerId: string, status: ProviderStatus, emit: boolean): void {
    this.statuses.set(providerId, status);
    if (emit) {
      this.statusEmitter.fire({ providerId, status });
    }
    this.scheduleRetry(providerId);
  }

  /** MissingDependency / Failed re-check on a timer (§11.1, rule: 10 min). */
  private scheduleRetry(providerId: string): void {
    const existing = this.retryTimers.get(providerId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.retryTimers.delete(providerId);
    }
    const health = this.currentHealth(providerId);
    if (health !== ProviderHealth.MissingDependency && health !== ProviderHealth.Failed) {
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(providerId);
      void this.healthCheck(providerId);
    }, this.healthCheckRetryMs);
    timer.unref?.();
    this.retryTimers.set(providerId, timer);
  }

  private async checkCommand(command: readonly string[] | undefined): Promise<HealthResult> {
    if (!command || command.length === 0) {
      // Realtime-adapter case: no declared check ⇒ healthy while registered.
      return { health: ProviderHealth.Ready };
    }
    try {
      await runCommand(command, this.healthCheckTimeoutMs);
      return { health: ProviderHealth.Ready };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (isMissingBinary(cause)) {
        return { health: ProviderHealth.MissingDependency, message: cause.message };
      }
      return { health: ProviderHealth.Misconfigured, message: cause.message };
    }
  }
}

/** Promise with a hard timeout — a hung check/scan never blocks the engine. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(value);
      },
      (error) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(error);
      },
    );
  });
}

/** Run a command, rejecting with a descriptive error on failure. */
function runCommand(command: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const [bin, ...args] = command;
    if (!bin) {
      reject(new Error('empty health check command'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`health check command timed out: ${command.join(' ')}`));
      }
    }, timeoutMs);
    timer.unref?.();
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolve();
        return;
      }
      const hint = stderr?.toString().trim() || '';
      reject(
        new Error(
          `command failed (${codeOf(error)}): ${command.join(' ')}${hint ? ` — ${hint}` : ''}`,
        ),
      );
    });
  });
}

/** A missing binary surfaces as ENOENT with a matching code. */
function isMissingBinary(error: Error): boolean {
  return 'code' in error && error.code === 'ENOENT';
}

function codeOf(error: { code?: string | number | null }): string {
  return error.code === undefined || error.code === null ? 'unknown' : String(error.code);
}
