// @pe/provider-vscode-realtime — "Realtime" diagnostics provider: the
// editor provides diagnostics directly (VS Code Language Servers, LSP
// push). This provider models that: the HOST forwards pushed diagnostics
// (`handle()`) and the engine's scans read the latest snapshot with this
// provider's identity. No child process, no health command.
//
// Lifecycle:
//   - healthCheck() → Ready always (nothing to probe away from an editor).
//   - scan(context) → returns the current snapshot for the requested URIs.
//   - handle(uri, diagnostics) → host-side push (called by the vscode
//     consumer layer).

import { ProviderHealth } from '@pe/provider-sdk';
import type {
  Diagnostic,
  HealthResult,
  Provider,
  ProviderCapabilities,
  ScanContext,
  ScanResult,
  ScannedFileDiagnostics,
  Uri,
} from '@pe/provider-sdk';

const CAPABILITIES: ProviderCapabilities = {
  confidenceTier: 2, // Realtime — authoritative only for open files
  supportedConfigTypes: [], // consumes, never produces projects
  workspaceScan: false,
  incrementalScan: false,
  realtime: true,
  extensions: [],
  cost: 'cheap',
};

export class RealtimeDiagnosticsProvider implements Provider {
  readonly id = 'vscode'; // per §7 id
  readonly displayName = 'Editor diagnostics';
  readonly capabilities = CAPABILITIES;
  readonly configSchema = { type: 'object', properties: { enabled: { type: 'boolean' } } };
  readonly defaultConfig = { enabled: true };

  /** Latest diagnostics per URI key (canonical `toString()`). */
  private readonly latest = new Map<string, readonly Diagnostic[]>();

  /** Host side: refresh the snapshot for a URI. */
  handle(uri: Uri, diagnostics: readonly Diagnostic[]): void {
    const key = uri.toString();
    if (diagnostics.length === 0) {
      this.latest.delete(key);
    } else {
      this.latest.set(key, diagnostics);
    }
  }

  /** Clears all snapshots (host IDE closed / workspace switched). */
  clear(): void {
    this.latest.clear();
  }

  async scan(context: ScanContext): Promise<ScanResult> {
    const files: ScannedFileDiagnostics[] = [];
    for (const uri of context.uris ?? []) {
      const diagnostics = this.latest.get(uri.toString());
      if (diagnostics !== undefined) {
        files.push({ uri, diagnostics });
      }
    }
    return { changedUris: context.uris ?? [], ...(files.length > 0 ? { files } : {}) };
  }

  async healthCheck(): Promise<HealthResult> {
    return { health: ProviderHealth.Ready };
  }
}
