// @pe/api — the public consumer surface. DiagnosticsAPI + stable types.
// The only package consumers install (§4).

export { DiagnosticsAPI } from './diagnostics-api.js';
export type { DiagnosticsAPIOptions } from './diagnostics-api.js';
export type {
  Diagnostic,
  DiagnosticsChangedEvent,
  EngineConfig,
  Event,
  FileChange,
  FileChangeEvent,
  HealthResult,
  ProblemChangeEvent,
  ProblemSeverity,
  ProblemSummary,
  ProblemTotals,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderHealth,
  ProviderStatus,
  ProviderStatusChangeEvent,
  ScanContext,
  ScanJob,
  ScanJobCompleteEvent,
  ScanJobFailedEvent,
  ScanPlan,
  ScanPriority,
  ScanQueueOverflowEvent,
  ScanResult,
  ScanStateEvent,
  ScanType,
  ScannedFileDiagnostics,
  TotalsChangedEvent,
  Uri,
} from '@pe/core';
