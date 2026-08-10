// @pe/scheduler — ProviderRegistry, ProviderQueue, ScanScheduler.
// Purely mechanical: when, concurrency, ordering, cancellation. Accepts
// ScanPlans, never infers scope, never references provider IDs.

export {
  ProviderRegistry,
  withTimeout,
  HEALTH_CHECK_RETRY_MS,
} from './registry/provider-registry.js';
export type { ProviderRegistryOptions } from './registry/provider-registry.js';
export { ProviderQueue } from './scheduler/provider-queue.js';
export type { ProviderQueueOptions } from './scheduler/provider-queue.js';
export { ScanScheduler } from './scheduler/scan-scheduler.js';
export type { ScanSchedulerOptions } from './scheduler/scan-scheduler.js';
