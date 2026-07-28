import { ProviderRegistry } from './ProviderRegistry';
import { VSCodeDiagnosticProvider } from './VSCodeDiagnosticProvider';
import { ProviderRegistrationContext } from './index';

const DESCRIPTOR = {
  id: 'vscodeDiagnostics',
  displayName: 'VS Code Diagnostics',
  priority: 5,
  type: 'realtime' as const,
  capabilities: { extensions: [], realtime: true, manualScan: false, startupScan: false },
  defaultEnabled: true,
};

export function register(registry: ProviderRegistry, ctx: ProviderRegistrationContext): void {
  const provider = new VSCodeDiagnosticProvider(
    ctx.store,
    ctx.vscodeLanguagesDelegate,
    ctx.log,
  );
  registry.register(provider, DESCRIPTOR);
}

export { DESCRIPTOR };
