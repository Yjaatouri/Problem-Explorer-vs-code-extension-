// Configuration validation using JSON Schema (jsonschema).

import { Validator, type Schema } from 'jsonschema';
import { ConfigError } from '../errors/index.js';

/** Validate `config` against `schema`; throws ConfigError on failure. */
export function validateConfig<T>(config: unknown, schema: Schema): T {
  const validator = new Validator();
  const result = validator.validate(config, schema, { throwError: false });

  if (!result.valid) {
    const details = result.errors.map((e) => `${e.property}: ${e.message}`).join('; ');
    throw new ConfigError(`Configuration validation failed: ${details}`, { schema: schema.$id });
  }

  return config as T;
}

/** Collect default values declared in a JSON Schema (`default` keyword) */
function extractDefaults(schema: Schema, path = ''): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  if (schema.default !== undefined) {
    return { [path]: schema.default };
  }

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      Object.assign(defaults, extractDefaults(propSchema as Schema, childPath));
    }
  }

  return defaults;
}

/** Merge user config with schema-declared defaults. User values win. */
export function mergeWithDefaults<T>(config: Partial<T>, schema: Schema): T {
  const defaults = extractDefaults(schema);
  const merged: Record<string, unknown> = { ...defaults };

  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged as T;
}

/** Merge defaults, then validate the result. Used by providers for their config. */
export function validateProviderConfig<T extends object>(
  userConfig: Partial<T>,
  schema: Schema,
): T {
  const merged = mergeWithDefaults(userConfig, schema);
  return validateConfig<T>(merged, schema);
}
