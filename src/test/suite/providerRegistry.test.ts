import * as assert from 'assert';
import { Uri, EventEmitter } from 'vscode';
import { ProviderRegistry, ProviderDescriptor, ProviderType } from '../../providers/ProviderRegistry';
import { DiagnosticProviderManager } from '../../providers/DiagnosticProviderManager';
import { DiagnosticProvider } from '../../providers/DiagnosticProvider';
import { ProblemStore } from '../../store/ProblemStore';
import { ProviderCapabilities, ScanProgress } from '../../core/types';

class MockProvider implements DiagnosticProvider {
  readonly name: string;
  readonly store: ProblemStore;
  readonly capabilities: ProviderCapabilities;
  readonly scanning = false;
  readonly autoScan = true;
  readonly enabled = true;
  readonly onDidProgressScan = new EventEmitter<ScanProgress>().event;
  private _onDidUpdate = new EventEmitter<Uri[]>();
  readonly onDidUpdate = this._onDidUpdate.event;
  private _disposed = false;

  constructor(name: string, store: ProblemStore, capabilities: ProviderCapabilities) {
    this.name = name;
    this.store = store;
    this.capabilities = capabilities;
  }

  initialize(): void {}
  start(): void {}
  stop(): void {}
  refresh(): void {}
  dispose(): void { this._disposed = true; }
  releaseOwnership(): void {}
}

function makeRegistry() {
  const store = new ProblemStore();
  const dpm = new DiagnosticProviderManager();
  const registry = new ProviderRegistry(dpm, store);
  return { store, dpm, registry };
}

function describe(
  caps: ProviderCapabilities,
  priority: number,
  defaultEnabled = true,
  type?: ProviderType,
  id = 'mock',
  displayName = 'Mock',
): ProviderDescriptor {
  return { id, displayName, priority, type, capabilities: caps, defaultEnabled };
}

suite('ProviderRegistry', () => {
  const tscCaps: ProviderCapabilities = { extensions: ['.ts', '.tsx'], manualScan: true, startupScan: true, fullWorkspace: true, realtime: false };
  const eslintCaps: ProviderCapabilities = { extensions: ['.js', '.jsx'], manualScan: true, startupScan: true, fullWorkspace: true, realtime: false };
  const realCaps: ProviderCapabilities = { extensions: [], realtime: true };

  test('register writes priority to both DPM and ProblemStore', () => {
    const { store, dpm, registry } = makeRegistry();
    const provider = new MockProvider('tsc', store, tscCaps);
    registry.register(provider, describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.strictEqual(registry.getPriority('tsc'), 10);
    assert.strictEqual(store.getProviderPriority('tsc'), 10);
  });

  test('register rejects id mismatch with provider.name', () => {
    const { store, registry } = makeRegistry();
    const provider = new MockProvider('tsca', store, tscCaps);
    assert.throws(() => registry.register(provider, describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript')), /must match/);
  });

  test('register rejects duplicates', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.throws(() => registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript')), /already registered/);
  });

  test('all() enumerates providers in priority order (highest first)', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('vscodeDiagnostics', store, realCaps), describe(realCaps, 5, true, 'realtime', 'vscodeDiagnostics', 'VS Code'));
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    registry.register(new MockProvider('eslint', store, eslintCaps), describe(eslintCaps, 9, true, 'scanner', 'eslint', 'ESLint'));
    const all = registry.all();
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0].name, 'tsc');
    assert.strictEqual(all[1].name, 'eslint');
    assert.strictEqual(all[2].name, 'vscodeDiagnostics');
  });

  test('getDescriptor returns descriptor by id', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    const desc = registry.getDescriptor('tsc');
    assert.ok(desc);
    assert.strictEqual(desc!.displayName, 'TypeScript');
    assert.strictEqual(desc!.priority, 10);
    assert.strictEqual(desc!.defaultEnabled, true);
  });

  test('isEnabled queries runtime provider.enabled', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.strictEqual(registry.isEnabled('tsc'), true);
    // Unknown providers report false.
    assert.strictEqual(registry.isEnabled('nonexistent'), false);
  });

  test('getPriority returns descriptor priority', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.strictEqual(registry.getPriority('tsc'), 10);
    assert.strictEqual(registry.getPriority('absent'), undefined);
  });

  test('getType returns descriptor type', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('vscodeDiagnostics', store, realCaps), describe(realCaps, 5, true, 'realtime', 'vscodeDiagnostics', 'VS Code'));
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.strictEqual(registry.getType('vscodeDiagnostics'), 'realtime');
    assert.strictEqual(registry.getType('tsc'), 'scanner');
  });

  test('getOwner resolves extension to highest-priority scanner', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('vscodeDiagnostics', store, realCaps), describe(realCaps, 5, true, 'realtime', 'vscodeDiagnostics', 'VS Code'));
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    registry.register(new MockProvider('eslint', store, eslintCaps), describe(eslintCaps, 9, true, 'scanner', 'eslint', 'ESLint'));
    assert.strictEqual(registry.getOwner('.ts'), 'tsc');
    assert.strictEqual(registry.getOwner('.tsx'), 'tsc');
    assert.strictEqual(registry.getOwner('.js'), 'eslint');
    // Unknown extensions return undefined (realtime fallback).
    assert.strictEqual(registry.getOwner('.py'), undefined);
  });

  test('realtime providers never own extensions', () => {
    const { store, registry } = makeRegistry();
    const caps: ProviderCapabilities = { extensions: ['.anything'], realtime: true };
    registry.register(new MockProvider('rt', store, caps), describe(caps, 100, true, 'realtime', 'rt', 'Realtime'));
    assert.strictEqual(registry.getOwner('.anything'), undefined);
  });

  test('getOwnedExtensions returns extensions claimed by a provider', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    const exts = registry.getOwnedExtensions('tsc');
    assert.deepStrictEqual([...exts].sort(), ['.ts', '.tsx']);
  });

  test('disabled scanner is skipped in ownership map', () => {
    const { store, registry } = makeRegistry();
    const provider = new MockProvider('tsc', store, tscCaps);
    (provider as any).enabled = false;
    registry.register(provider, describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    // Without tsc claiming .ts, the ownership map should be empty.
    assert.strictEqual(registry.getOwner('.ts'), undefined);
  });

  test('unregister removes descriptor and store priority', () => {
    const { store, registry } = makeRegistry();
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.ok(registry.getDescriptor('tsc'));
    assert.strictEqual(registry.getPriority('tsc'), 10);
    registry.unregister('tsc');
    assert.strictEqual(registry.getDescriptor('tsc'), undefined);
    assert.strictEqual(registry.getPriority('tsc'), undefined);
    assert.strictEqual(registry.getOwner('.ts'), undefined);
  });

  test('onDidRegister fires with descriptor', () => {
    const { store, registry } = makeRegistry();
    let fired: any = undefined;
    registry.onDidRegister((e) => { fired = e; });
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.ok(fired);
    assert.strictEqual(fired.descriptor.id, 'tsc');
    assert.strictEqual(fired.descriptor.priority, 10);
  });

  test('onDidUnregister fires with id', () => {
    const { store, registry } = makeRegistry();
    let fired: string | undefined;
    registry.onDidUnregister((e) => { fired = e.id; });
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    registry.unregister('tsc');
    assert.strictEqual(fired, 'tsc');
  });

  test('size tracks registered count', () => {
    const { store, registry } = makeRegistry();
    assert.strictEqual(registry.size, 0);
    registry.register(new MockProvider('tsc', store, tscCaps), describe(tscCaps, 10, true, 'scanner', 'tsc', 'TypeScript'));
    assert.strictEqual(registry.size, 1);
    registry.register(new MockProvider('eslint', store, eslintCaps), describe(eslintCaps, 9, true, 'scanner', 'eslint', 'ESLint'));
    assert.strictEqual(registry.size, 2);
    registry.unregister('tsc');
    assert.strictEqual(registry.size, 1);
  });
});
