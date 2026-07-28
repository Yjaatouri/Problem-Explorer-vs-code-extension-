import { DiagnosticProviderManager } from './DiagnosticProviderManager';
import { ProblemStore } from '../store/ProblemStore';
import { Config } from '../core/types';
import { ProviderRegistry } from './ProviderRegistry';
import { DiagnosticsDelegate } from '../diagnostics/diagnosticsManager';

/**
 * Context handed to every provider's `register()` function. Carries everything
 * a provider module needs to construct and register itself — extension.ts no
 * longer constructs providers directly.
 *
 * `vscodeLanguagesDelegate` is the only non-injectable dependency (it wraps
 * `vscode.languages.getDiagnostics` etc.). It is constructed in extension.ts
 * where the `vscode` API is available and passed here.
 */
export interface ProviderRegistrationContext {
  readonly store: ProblemStore;
  readonly config: Config;
  readonly log: (msg: string) => void;
  /** The DPM is needed by EslintDiagnosticProvider's constructor (legacy design
   * — kept until T0.7 separates the factory pattern cleanly). */
  readonly manager: DiagnosticProviderManager;
  /** Constructed once in extension.ts from the vscode API; the realtime
   * provider subscribes to it. */
  readonly vscodeLanguagesDelegate: DiagnosticsDelegate;
}

/**
 * A provider module's registration entry point.
 * Convention: each provider module in this directory exports
 * `export function register(registry, ctx): RegisteredProviderHandle`.
 */
export type ProviderRegisterFn = (registry: ProviderRegistry, ctx: ProviderRegistrationContext) => void;

/**
 * The set of provider modules activated by the extension.
 *
 * To add a new provider:
 *   1. Create a file under `src/providers/<lang>/`.
 *   2. Export a `register(registry, ctx)` function that constructs the
 *      provider instance and calls `registry.register(provider, descriptor)`.
 *   3. Import it here and append it to the array.
 *
 * extension.ts is the ONLY other consumer of this list — it iterates the array
 * once during activate() and never looks at it again. Auto-discovery via
 * glob/scandir would also work, but a static list keeps startup fast, keeps
 * tree-shaking effective, and surfaces new providers in code review.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vsCodeProviderModule = require('./VSCodeDiagnosticProvider.module');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tscProviderModule = require('./TscDiagnosticProvider.module');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eslintProviderModule = require('./EslintDiagnosticProvider.module');

export const ALL_PROVIDER_MODULES: readonly ProviderRegisterFn[] = [
  vsCodeProviderModule.register,
  tscProviderModule.register,
  eslintProviderModule.register,
];

/**
 * Register all known providers via the registry. extension.ts calls this once
 * during activate(), after constructing the ProviderRegistry.
 *
 * Returns a map of provider id → DiagnosticProvider instance so the caller can
 * pass typed handles to per-provider config setters (T0.7 will replace the
 * setters with a generic config dispatch).
 */
export function registerAllProviders(
  registry: ProviderRegistry,
  ctx: ProviderRegistrationContext,
): { readonly [id: string]: ReturnType<ProviderRegistry['getProvider']> } {
  const handles: Record<string, ReturnType<ProviderRegistry['getProvider']>> = {};
  for (const register of ALL_PROVIDER_MODULES) {
    const before = new Set(registry.descriptors().map((d) => d.id));
    register(registry, ctx);
    for (const desc of registry.descriptors()) {
      if (!before.has(desc.id)) {
        handles[desc.id] = registry.getProvider(desc.id);
      }
    }
  }
  return handles;
}
