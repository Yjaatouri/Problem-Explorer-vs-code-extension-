export class ExtensionError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'ExtensionError';
  }
}

export class ConfigurationError extends ExtensionError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigurationError';
  }
}

export class CacheError extends ExtensionError {
  constructor(message: string) {
    super(message, 'CACHE_ERROR');
    this.name = 'CacheError';
  }
}
