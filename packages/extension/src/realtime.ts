import type { Diagnostic, Uri } from '@pe/api';

import type { DisposableLike } from './types.js';
import type { EngineApi } from './engine.js';
import type { SeverityOverrides, EditorDiagnosticLike } from './severity.js';
import { toEngineDiagnostic } from './severity.js';
import type { FileLikeUri } from './ignore.js';

export interface LanguagesBridge {
  getDiagnostics(uri: Uri): readonly EditorDiagnosticLike[];
}

/**
 * Forwards VS Code editor diagnostics into the engine's realtime provider.
 * Ownership rules live in the engine: while a scanner is Ready for a file's
 * capability it wins; otherwise the editor owns the file (§9.2).
 */
export class RealtimeDiagnosticsBridge implements DisposableLike {
  private readonly subscriptions: DisposableLike[] = [];

  constructor(
    private readonly getEngine: () => EngineApi | undefined,
    private readonly workspaceRoot: Uri,
    private readonly languages: LanguagesBridge,
    private readonly isIgnoredUri: (uri: FileLikeUri) => boolean,
    private readonly severityOverrides: SeverityOverrides | undefined,
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

  /** Push the current editor diagnostics for one URI into the engine. */
  pushUri(uri: Uri): void {
    const engine = this.engine;
    if (!engine) {
      return;
    }
    const mapped: Diagnostic[] = this.languages
      .getDiagnostics(uri)
      .map((diag) => toEngineDiagnostic(diag, this.severityOverrides, uri.fsPath));
    engine.realtime.handle(uri, mapped);
    engine.api.reportEditorDiagnostics(uri, mapped);
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