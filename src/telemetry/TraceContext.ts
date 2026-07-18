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

/** Active trace context storage (async-local-storage style via Map) */
const traceContexts = new Map<string, TraceContext>();

/** Get current trace context for a given async key */
export function getCurrentTraceContext(key: string = 'default'): TraceContext | undefined {
  return traceContexts.get(key);
}

/** Create a new trace context and make it current for the given key */
export function createTrace(
  operation: string,
  source: string,
  metadata?: Record<string, unknown>,
  key: string = 'default'
): TraceContext {
  const traceId = generateTraceId();
  const ctx: TraceContext = {
    traceId,
    startTime: Date.now(),
    source,
    operation,
    metadata,
  };
  traceContexts.set(key, ctx);
  return ctx;
}

/** Continue an existing trace (for child operations) */
export function continueTrace(
  parentTraceId: TraceId,
  operation: string,
  source: string,
  metadata?: Record<string, unknown>,
  key: string = 'default'
): TraceContext {
  const ctx: TraceContext = {
    traceId: generateTraceId(),
    parentTraceId,
    startTime: Date.now(),
    source,
    operation,
    metadata,
  };
  traceContexts.set(key, ctx);
  return ctx;
}

/** End a trace and return its duration */
export function endTrace(key: string = 'default'): { traceId: TraceId; durationMs: number } | undefined {
  const ctx = traceContexts.get(key);
  if (!ctx) return undefined;
  traceContexts.delete(key);
  return { traceId: ctx.traceId, durationMs: Date.now() - ctx.startTime };
}

/** Get trace ID for current context (for adding to telemetry events) */
export function getCurrentTraceId(key: string = 'default'): TraceId | undefined {
  return traceContexts.get(key)?.traceId;
}

/** Get parent trace ID for current context */
export function getCurrentParentTraceId(key: string = 'default'): TraceId | undefined {
  return traceContexts.get(key)?.parentTraceId;
}

/** Clear all trace contexts (for testing) */
export function clearTraceContexts(): void {
  traceContexts.clear();
}

/** Run a function with a trace context */
export function withTrace<T>(
  operation: string,
  source: string,
  fn: (ctx: TraceContext) => T | Promise<T>,
  metadata?: Record<string, unknown>,
  key: string = 'default'
): T | Promise<T> {
  const ctx = createTrace(operation, source, metadata, key);
  try {
    const result = fn(ctx);
    if (result instanceof Promise) {
      return result.finally(() => endTrace(key));
    }
    endTrace(key);
    return result;
  } catch (err) {
    endTrace(key);
    throw err;
  }
}

/** Run a function with a continued trace context */
export function withContinuedTrace<T>(
  parentTraceId: TraceId,
  operation: string,
  source: string,
  fn: (ctx: TraceContext) => T | Promise<T>,
  metadata?: Record<string, unknown>,
  key: string = 'default'
): T | Promise<T> {
  const ctx = continueTrace(parentTraceId, operation, source, metadata, key);
  try {
    const result = fn(ctx);
    if (result instanceof Promise) {
      return result.finally(() => endTrace(key));
    }
    endTrace(key);
    return result;
  } catch (err) {
    endTrace(key);
    throw err;
  }
}