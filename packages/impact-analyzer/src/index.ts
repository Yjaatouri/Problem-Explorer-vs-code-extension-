// @pe/impact-analyzer — all change-intelligence lives here (§5.8).
// Converts workspace events into minimal ScanPlans; owns the DiagnosticCache
// staleness oracle.

export { DiagnosticCache, DEFAULT_TTL_MS } from './diagnostic-cache.js';
export type { DiagnosticCacheOptions, ScanMetadata } from './diagnostic-cache.js';
export { ImpactAnalyzer, DEFAULT_DEBOUNCE_MS, DEFAULT_BATCH_MS } from './impact-analyzer.js';
export type { ImpactAnalyzerOptions } from './impact-analyzer.js';
