import { ProviderRegistry } from './ProviderRegistry';
import { TscDiagnosticProvider } from './TscDiagnosticProvider';
import { ProviderRegistrationContext } from './index';

const DESCRIPTOR = {
  id: 'tsc',
  displayName: 'TypeScript (tsc)',
  priority: 10,
  type: 'scanner' as const,
  capabilities: {
    extensions: ['.ts', '.tsx'],
    realtime: false,
    manualScan: true,
    startupScan: true,
    fullWorkspace: true,
  },
  defaultEnabled: true,
  configSection: 'typescript',
};

export function register(registry: ProviderRegistry, ctx: ProviderRegistrationContext): void {
  const providerConfig = registry.getProviderConfig('tsc');
  const provider = new TscDiagnosticProvider(ctx.store, {
    timeoutMs: providerConfig?.timeout,
  });
  registry.register(provider, DESCRIPTOR);
}

export { DESCRIPTOR };
