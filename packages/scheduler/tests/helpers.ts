// Shared test helpers for @pe/scheduler tests.

import { ConfidenceTier, ProviderHealth } from '@pe/core';
import type { Provider, ProviderCapabilities, ScanContext, ScanResult, Uri } from '@pe/core';

/** Structural engine Uri (no vscode). */
export function testUri(fsPath: string): Uri {
  const normalized = fsPath.replace(/\\/g, '/');
  const withScheme = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const uriString = `file:///${withScheme}`;
  return {
    scheme: 'file',
    authority: '',
    path: withScheme,
    fsPath,
    toString: () => uriString,
    with: (change) => testUri(change.path ?? fsPath),
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface FakeProviderOptions {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Health returned by healthCheck (defaults to Ready). */
  readonly health?: ProviderHealth;
  /** Custom scan implementation. */
  readonly scanImpl?: (context: ScanContext) => Promise<ScanResult>;
  /** When set, the scan waits for this deferred before resolving. */
  readonly gate?: Deferred<void>;
}

export interface FakeProvider {
  readonly provider: Provider;
  /** Every ScanContext the provider has received. */
  readonly calls: readonly ScanContext[];
}

/** A ready-to-register fake provider plus its call log. */
export function makeProvider(options: FakeProviderOptions): FakeProvider {
  const calls: ScanContext[] = [];
  const provider: Provider = {
    id: options.id,
    displayName: options.displayName ?? options.id,
    capabilities: {
      confidenceTier: ConfidenceTier.WorkspaceScanner,
      supportedConfigTypes: ['typescript'],
      workspaceScan: true,
      incrementalScan: true,
      realtime: false,
      extensions: ['.ts'],
      cost: 'medium',
      ...options.capabilities,
    },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    healthCheck: async () => ({ health: options.health ?? ProviderHealth.Ready }),
    scan: async (context) => {
      calls.push(context);
      if (options.gate !== undefined) {
        await options.gate.promise;
      }
      if (options.scanImpl !== undefined) {
        return options.scanImpl(context);
      }
      const files = context.uris?.map((uri) => ({ uri, diagnostics: [] })) ?? [];
      return { changedUris: context.uris ?? [], files };
    },
  };
  return { provider, calls };
}

/** Await until `condition` holds (polling; avoids flaky sleeps). */
export async function waitFor(
  condition: () => boolean | undefined,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
