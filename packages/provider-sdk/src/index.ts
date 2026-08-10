// @pe/provider-sdk — the public contract for provider authors (§12.1).
//
// External contract: providers depend on ONLY this package (never internal
// engine packages, rule 6.9). It re-exports the engine types providers
// legitimately need plus the URI helper the SDK promises (§6.1: "Node
// consumers ... may use the helper in the SDK").

export type {
  ConfigType,
  Cost,
  Diagnostic,
  Event,
  HealthResult,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ScanContext,
  ScanErrorInfo,
  ScanResult,
  ScannedFileDiagnostics,
  Schema,
  Uri,
} from '@pe/core';
export { ConfidenceTier, ProblemSeverity, ProviderHealth, ScanType } from '@pe/core';

export { fileUriFromPath } from './uri.js';
