// Custom error classes for the engine.
// Throw for programming errors / invariant violations; use Result for expected failures.

/** Base class of all engine errors; subclasses carry stable `code`s. */
export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EngineError';
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ConfigError extends EngineError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context);
    this.name = 'ConfigError';
  }
}

export class ProviderError extends EngineError {
  constructor(
    message: string,
    public readonly providerId: string,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message, code, { providerId, ...context });
    this.name = 'ProviderError';
  }
}

export class ScanError extends EngineError {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly uri: string,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message, code, { providerId, uri, ...context });
    this.name = 'ScanError';
  }
}

export class HealthCheckError extends EngineError {
  constructor(
    message: string,
    public readonly providerId: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'HEALTH_CHECK_FAILED', { providerId, ...context });
    this.name = 'HealthCheckError';
  }
}

export class WorkspaceIndexError extends EngineError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'WorkspaceIndexError';
  }
}

export class CacheError extends EngineError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'CacheError';
  }
}

export class SchedulerError extends EngineError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = 'SchedulerError';
  }
}

/** Result type for operations that can fail expectedly */
export type Result<T, E extends EngineError = EngineError> =
  { success: true; value: T } | { success: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { success: true, value };
}

export function err<E extends EngineError>(error: E): Result<never, E> {
  return { success: false, error };
}
