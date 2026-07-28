import { ProviderRegistry } from './ProviderRegistry';
import { EslintDiagnosticProvider } from './EslintDiagnosticProvider';
import { ProviderRegistrationContext } from './index';

const DESCRIPTOR = {
  id: 'eslint',
  displayName: 'ESLint',
  priority: 9,
  type: 'scanner' as const,
  capabilities: {
    extensions: ['.js', '.jsx', '.vue', '.svelte'],
    realtime: false,
    manualScan: true,
    startupScan: true,
    fullWorkspace: true,
  },
  defaultEnabled: true,
  configSection: 'eslint',
};

export function register(registry: ProviderRegistry, ctx: ProviderRegistrationContext): void {
  const provider = new EslintDiagnosticProvider(ctx.store, ctx.manager);
  registry.register(provider, DESCRIPTOR);
}

export { DESCRIPTOR };
