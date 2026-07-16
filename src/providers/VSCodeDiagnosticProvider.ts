import { Uri, Event } from 'vscode';
import { DiagnosticProvider } from './DiagnosticProvider';
import { DiagnosticsManager, DiagnosticsDelegate } from '../diagnostics/diagnosticsManager';
import { ProblemStore } from '../store/ProblemStore';
import { ProblemState, ProviderCapabilities } from '../core/types';

export class VSCodeDiagnosticProvider implements DiagnosticProvider {
  readonly name = 'vscodeDiagnostics';
  readonly capabilities: ProviderCapabilities = {
    extensions: [],
    realtime: true,
  };
  private readonly manager: DiagnosticsManager;

  get store(): ProblemStore {
    return this.manager.store;
  }

  get scanning(): boolean {
    return this.manager.scanning;
  }

  get autoScan(): boolean {
    return this.manager.autoScan;
  }

  get enabled(): boolean {
    return true;
  }

  get onDidUpdate(): Event<Uri[]> {
    return this.manager.onDidUpdate;
  }

  constructor(store: ProblemStore, delegate?: DiagnosticsDelegate, log?: (msg: string) => void) {
    this.manager = new DiagnosticsManager(store, delegate, log);
  }

  initialize(): void {
    this.manager.initialize();
  }

  start(): void {
    this.manager.start();
  }

  stop(): void {
    this.manager.stop();
  }

  refresh(): void {
    this.manager.refresh();
  }

  dispose(): void {
    this.store.unconfigureProvider(this.name);
    this.manager.dispose();
  }

  releaseOwnership(): void {
    this.store.releaseOwnership(this.name);
  }

  fullScan(): Uri[] {
    return this.manager.fullScan();
  }

  setSeverityOverrides(overrides: Record<string, Record<string, string>> | undefined): void {
    this.manager.setSeverityOverrides(overrides);
  }

  setIgnorePatterns(patterns: string[]): void {
    this.manager.setIgnorePatterns(patterns);
  }

  startInitPoll(): void {
    this.manager.startInitPoll();
  }

  getStatus(uri: Uri): ProblemState | undefined {
    return this.manager.getStatus(uri);
  }
}
