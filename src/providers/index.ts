import { DiagnosticProviderManager } from './DiagnosticProviderManager';
import { ProblemStore } from '../store/ProblemStore';
import { ProviderRegistry } from './ProviderRegistry';
import { DiagnosticsDelegate } from '../diagnostics/diagnosticsManager';

// Provider module register functions — each module exports `register()`.
// Adding a new provider = create a *.module.ts file + append its register fn here.
import { register as registerVsCodeDiagnostics } from './VSCodeDiagnosticProvider.module';
import { register as registerTsc } from './TscDiagnosticProvider.module';
import { register as registerEslint } from './EslintDiagnosticProvider.module';

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
  readonly log: (msg: string) => void;
  /** The DPM is needed by EslintDiagnosticProvider's constructor (legacy design). */
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
export const ALL_PROVIDER_MODULES: readonly ProviderRegisterFn[] = [
  registerVsCodeDiagnostics,
  registerTsc,
  registerEslint,
];

/**
 * Register all known providers via the registry. extension.ts calls this once
 * during activate(), after constructing the ProviderRegistry.
 *
 * Returns a map of provider id → DiagnosticProvider instance so the caller can
 * pass typed handles to per-provider config setters (pre-T0.8 compat — new
 * providers should read config via registry.getProviderConfig() instead).
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
