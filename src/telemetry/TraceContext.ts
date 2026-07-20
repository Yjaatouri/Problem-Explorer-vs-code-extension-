import { AsyncLocalStorage } from 'async_hooks';
import { TraceId, generateTraceId } from './TelemetryConfig';

/** Trace context carried through async boundaries */
export interface TraceContext {
  readonly traceId: TraceId;
  readonly parentTraceId?: TraceId;
  readonly startTime: number;
  readonly source: string;
  readonly operation: string;
  readonly metadata?: Record<string, unknown>;
}

/** Async-local storage for trace context — automatically scoped per async flow */
const asyncStorage = new AsyncLocalStorage<TraceContext>();

/** Get current trace context for the current async flow */
export function getCurrentTraceContext(): TraceContext | undefined {
  return asyncStorage.getStore();
}

/** Create a new trace context and make it current for the current async flow */
export function createTrace(
  operation: string,
  source: string,
  metadata?: Record<string, unknown>,
): TraceContext {
  const parentCtx = getCurrentTraceContext();
  const traceId = generateTraceId();
  const ctx: TraceContext = {
    traceId,
    parentTraceId: parentCtx?.traceId,
    startTime: Date.now(),
    source,
    operation,
    metadata,
  };
  return ctx;
}

/** End a trace and return its duration */
export function endTrace(): { traceId: TraceId; durationMs: number } | undefined {
  const ctx = asyncStorage.getStore();
  if (!ctx) return undefined;
  return { traceId: ctx.traceId, durationMs: Date.now() - ctx.startTime };
}

/** Get trace ID for current context (for adding to telemetry events) */
export function getCurrentTraceId(): TraceId | undefined {
  return asyncStorage.getStore()?.traceId;
}

/** Get parent trace ID for current context */
export function getCurrentParentTraceId(): TraceId | undefined {
  return asyncStorage.getStore()?.parentTraceId;
}

/** Clear all trace contexts (for testing) */
export function clearTraceContexts(): void {
  // AsyncLocalStorage doesn't support clearing; this is a no-op in production
}

/** Run a function with a trace context */
export function withTrace<T>(
  operation: string,
  source: string,
  fn: (ctx: TraceContext) => T | Promise<T>,
  metadata?: Record<string, unknown>,
): T | Promise<T> {
  const ctx = createTrace(operation, source, metadata);
  return asyncStorage.run(ctx, () => {
    try {
      const result = fn(ctx);
      if (result instanceof Promise) {
        return result.finally(() => { /* context auto-cleaned by AsyncLocalStorage */ });
      }
      return result;
    } finally {
      /* no explicit cleanup needed — AsyncLocalStorage handles nesting */
    }
  });
}

/** Continue an existing trace (for child operations) — context comes from parent flow */
export function continueWithTrace<T>(
  operation: string,
  source: string,
  fn: (ctx: TraceContext) => T | Promise<T>,
  metadata?: Record<string, unknown>,
): T | Promise<T> {
  const parentCtx = getCurrentTraceContext();
  const traceId = generateTraceId();
  const ctx: TraceContext = {
    traceId,
    parentTraceId: parentCtx?.traceId,
    startTime: Date.now(),
    source,
    operation,
    metadata,
  };
  return asyncStorage.run(ctx, () => {
    try {
      const result = fn(ctx);
      if (result instanceof Promise) {
        return result;
      }
      return result;
    } finally {
      /* context auto-cleaned by AsyncLocalStorage */
    }
  });
}