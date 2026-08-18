import type { Diagnostic, Uri } from '@pe/api';

import type { DisposableLike } from './types.js';
import type { EngineApi } from './engine.js';
import type { SeverityOverrides, EditorDiagnosticLike } from './severity.js';
import { toEngineDiagnostic } from './severity.js';
import type { FileLikeUri } from './ignore.js';

export interface LanguagesBridge {
  getDiagnostics(uri: Uri): readonly EditorDiagnosticLike[];
  /** Every diagnostic the editor currently knows, keyed by URI (backfill source). */
  getAllDiagnostics(): [Uri, readonly EditorDiagnosticLike[]][];
}

/**
 * Forwards VS Code editor diagnostics into the engine's realtime provider.
 * Ownership rules live in the engine: while a scanner is Ready for a file's
 * capability it wins; otherwise the editor owns the file (§9.2).
 *
 * syncAll() is a snapshot/backfill, NOT a poller: it is called when an engine
 * is created or rebuilt (and once more shortly after boot) so diagnostics
 * that changed before the engine existed are not lost forever.
 */
export class RealtimeDiagnosticsBridge implements DisposableLike {
  private readonly subscriptions: DisposableLike[] = [];

  constructor(
    private readonly getEngine: () => EngineApi | undefined,
    private readonly workspaceRoot: Uri,
    private readonly languages: LanguagesBridge,
    private readonly isIgnoredUri: (uri: FileLikeUri) => boolean,
    private readonly severityOverrides: SeverityOverrides | undefined,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Wire into `onDidChangeDiagnostics`; call once after the engine exists. */
  attach(changeListener: (listener: (uris: readonly Uri[]) => void) => DisposableLike): void {
    this.subscriptions.push(
      changeListener((uris) => {
        for (const uri of uris) {
          if (!wantsIn(uri, this.workspaceRoot, this.isIgnoredUri)) {
            continue;
          }
          this.pushUri(uri);
        }
      }),
    );
  }

  private get engine(): EngineApi | undefined {
    return this.getEngine();
  }

  /** Push the current editor diagnostics for one URI into the engine with retry logic. */
  pushUri(uri: Uri): void {
    this.attemptPush(uri, 0);
  }

  /** Attempt to push diagnostics with retry logic. */
  private attemptPush(uri: Uri, retryCount: number): void {
    const engine = this.engine;
    if (!engine) {
      if (retryCount >= 3) {
        this.log(`pushUri FAILED after ${retryCount} retries (no engine): ${uri.fsPath}`);
        return;
      }
      this.log(`pushUri RETRY ${retryCount + 1}/3 (no engine yet): ${uri.fsPath}`);
      setTimeout(() => this.attemptPush(uri, retryCount + 1), 100 * (retryCount + 1)); // 100ms, 200ms, 300ms
      return;
    }
    
    try {
      // First try editor diagnostics
      const editorDiagnostics = this.languages.getDiagnostics(uri);
      let mapped: readonly Diagnostic[] = editorDiagnostics
        .map((diag) => toEngineDiagnostic(diag, this.severityOverrides, uri.fsPath));
      
      // If no editor diagnostics, fall back to engine diagnostics for this URI
      if (mapped.length === 0) {
        const engineDiags = engine.api.getDiagnostics(uri);
        if (engineDiags.length > 0) {
          mapped = engineDiags;
          this.log(`pushUri ${uri.fsPath}: using engine diagnostics fallback (${mapped.length} diag(s))`);
        }
      }
      
      engine.realtime.handle(uri, mapped);
      engine.api.reportEditorDiagnostics(uri, mapped);
      this.log(
        `pushUri ${uri.fsPath}: ${mapped.length} diag(s) -> owners=[${engine.api
          .getOwners(uri)
          .join(',')}]`,
      );
    } catch (error) {
      if (retryCount >= 3) {
        this.log(`pushUri FAILED after ${retryCount} retries (error): ${uri.fsPath} - ${error}`);
        return;
      }
      this.log(`pushUri RETRY ${retryCount + 1}/3 (error): ${uri.fsPath} - ${error}`);
      setTimeout(() => this.attemptPush(uri, retryCount + 1), 100 * (retryCount + 1)); // 100ms, 200ms, 300ms
    }
  }

  /**
   * Backfill the engine with the editor's current diagnostics. Snapshot only:
   * call at engine creation/rebuild (and once after boot) to recover pushes
   * that raced ahead of the engine. Never a polling loop.
   */
  syncAll(): void {
    const engine = this.engine;
    if (!engine) {
      this.log('syncAll skipped (no engine)');
      return;
    }
    const snapshot = this.languages.getAllDiagnostics();
    let pushed = 0;
    for (const [uri, diagnostics] of snapshot) {
      if (!wantsIn(uri, this.workspaceRoot, this.isIgnoredUri)) {
        continue;
      }
      const mapped: Diagnostic[] = diagnostics.map((diag) =>
        toEngineDiagnostic(diag, this.severityOverrides, uri.fsPath),
      );
      engine.realtime.handle(uri, mapped);
      engine.api.reportEditorDiagnostics(uri, mapped);
      pushed += 1;
    }
    this.log(`syncAll: ${snapshot.length} editor entries, ${pushed} in scope`);
  }

  clear(): void {
    this.engine?.realtime.clear();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }
}

/** Gating: only in-workspace `file:` URIs that aren't ignored reach the engine. */
export function wantsIn(
  uri: Uri,
  workspaceRoot: Uri,
  isIgnoredUri: (uri: FileLikeUri) => boolean,
): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  // Compare via fsPath: uri.path can carry percent-encoding (e.g. `c%3A`)
  // that breaks naive string prefixes.
  const rootFs = workspaceRoot.fsPath.replace(/\\/g, '/').toLowerCase();
  const fileFs = uri.fsPath.replace(/\\/g, '/').toLowerCase();
  const inside = fileFs === rootFs || fileFs.startsWith(rootFs + '/');
  if (!inside) {
    return false;
  }
  return !isIgnoredUri({ scheme: uri.scheme, fsPath: uri.fsPath });
}