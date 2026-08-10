// ProblemStore — the engine's current truth.
//
// Holds the diagnostics consumers see today. Writes are priority-gated:
// a provider's diagnostics only affect the visible state when that provider
// owns the path (or no owner is recorded yet). Every provider's data is
// stored, so ownership transfers are atomic per path (§9.3): when ownership
// moves, the new owner's last known results become visible immediately.
//
// Never holds scan history — that is the DiagnosticCache's job (M3).

import {
  type Diagnostic,
  type DiagnosticsChangedEvent,
  normalizeUriKey,
  type OwnershipChangedEvent,
  ProblemSeverity,
  type ProblemSummary,
  type ProblemTotals,
  type TotalsChangedEvent,
  TypedEventEmitter,
  type Uri,
  ZERO_PROBLEM_STATE,
} from '@pe/core';

/** A single provider's diagnostics for one file */
type ProviderFileState = {
  diagnostics: readonly Diagnostic[];
};

/** Mutable accumulator — internal only; reads always return frozen summaries */
type MutableSummary = {
  severity: ProblemSeverity;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  fileCount: number;
};

function emptyMutable(): MutableSummary {
  return {
    severity: ProblemSeverity.None,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    fileCount: 0,
  };
}

function freezeSummary(summary: MutableSummary): ProblemSummary {
  return Object.freeze(summary);
}

function summarize(diagnostics: readonly Diagnostic[]): ProblemSummary {
  const summary = emptyMutable();
  let worst = ProblemSeverity.None;
  for (const diagnostic of diagnostics) {
    worst = Math.max(worst, diagnostic.severity);
    switch (diagnostic.severity) {
      case ProblemSeverity.Error:
        summary.errorCount += 1;
        break;
      case ProblemSeverity.Warning:
        summary.warningCount += 1;
        break;
      case ProblemSeverity.Info:
        summary.infoCount += 1;
        break;
      default:
        break;
    }
  }
  summary.severity = worst;
  summary.fileCount = diagnostics.length > 0 ? 1 : 0;
  return freezeSummary(summary);
}

function aggregateSummaries(summaries: readonly ProblemSummary[]): ProblemSummary {
  const result = emptyMutable();
  let worst = ProblemSeverity.None;
  for (const summary of summaries) {
    worst = Math.max(worst, summary.severity);
    result.errorCount += summary.errorCount;
    result.warningCount += summary.warningCount;
    result.infoCount += summary.infoCount;
    result.fileCount += summary.fileCount;
  }
  result.severity = worst;
  return freezeSummary(result);
}

export class ProblemStore {
  private readonly byFile = new Map<string, Map<string, ProviderFileState>>();
  private readonly ownerByFile = new Map<string, string>();
  private readonly summaryByFile = new Map<string, ProblemSummary>();
  private readonly diagnosticsChangedEmitter = new TypedEventEmitter<DiagnosticsChangedEvent>();
  private readonly totalsChangedEmitter = new TypedEventEmitter<TotalsChangedEvent>();
  private readonly ownershipChangedEmitter = new TypedEventEmitter<OwnershipChangedEvent>();
  private totalsSnapshot: Readonly<ProblemTotals> = Object.freeze({
    errors: 0,
    warnings: 0,
    info: 0,
  });
  private rejectedWrites = 0;

  /** Event: a provider's diagnostics for a file were applied to the visible state */
  readonly onDiagnosticsChanged = this.diagnosticsChangedEmitter.on.bind(
    this.diagnosticsChangedEmitter,
  );

  /** Event: running totals changed */
  readonly onTotalsChanged = this.totalsChangedEmitter.on.bind(this.totalsChangedEmitter);

  /** Event: the current owner of a path changed */
  readonly onOwnershipChanged = this.ownershipChangedEmitter.on.bind(this.ownershipChangedEmitter);

  /**
   * Set a provider's diagnostics for a file. Applied to the visible state only
   * when the provider owns the path or no owner is recorded; otherwise the
   * write is stored (for atomic swaps) but neither events nor totals change.
   */
  setDiagnostics(providerId: string, uri: Uri, diagnostics: readonly Diagnostic[]): void {
    const key = normalizeUriKey(uri);
    const providers = this.getOrCreateProviders(key);
    providers.set(providerId, { diagnostics });
    this.applyFileUpdate(uri, key, providerId, providers);
  }

  /** Remove a provider's diagnostics for a file (equivalent to an empty write). */
  removeDiagnostics(providerId: string, uri: Uri): void {
    const key = normalizeUriKey(uri);
    const providers = this.byFile.get(key);
    if (!providers || !providers.delete(providerId)) {
      return;
    }
    if (providers.size === 0) {
      this.byFile.delete(key);
    }
    this.applyFileUpdate(uri, key, providerId, providers);
  }

  /** All stored diagnostics for a file (union across providers). Frozen snapshot. */
  getDiagnostics(uri: Uri): readonly Diagnostic[] {
    const providers = this.byFile.get(normalizeUriKey(uri));
    if (!providers) {
      return Object.freeze([]);
    }
    return Object.freeze([...providers.values()].flatMap((state) => state.diagnostics));
  }

  /** Current summary for a single file (owner's diagnostics, or union if unowned). */
  getSummary(uri: Uri): ProblemSummary {
    return this.getFileSummary(normalizeUriKey(uri));
  }

  /** Aggregated summary for a folder and all its descendants. Worst severity wins. */
  getFolderSummary(folderUri: Uri): ProblemSummary {
    const folderKey = normalizeUriKey(folderUri) + '/';
    const summaries: ProblemSummary[] = [];
    for (const [key, summary] of this.summaryByFile) {
      if (key.startsWith(folderKey)) {
        summaries.push(summary);
      }
    }
    return aggregateSummaries(summaries);
  }

  /** Providers currently owning a path (empty when unowned). */
  getOwners(uri: Uri): string[] {
    const owner = this.ownerByFile.get(normalizeUriKey(uri));
    return owner === undefined ? [] : [owner];
  }

  /**
   * Record the current owner of a path. Called by the orchestration layer
   * (registry/scheduler) when ownership is decided or transferred.
   * The swap is atomic: totals and visible state update in one step.
   */
  recordOwner(uri: Uri, providerId: string | undefined): void {
    const key = normalizeUriKey(uri);
    const previous = this.ownerByFile.get(key);
    if (previous === providerId) {
      return;
    }
    if (providerId === undefined) {
      this.ownerByFile.delete(key);
    } else {
      this.ownerByFile.set(key, providerId);
    }
    this.recomputeFileSummary(key);
    this.ownershipChangedEmitter.fire({ uri, providerId, previousProviderId: previous });
  }

  /** Running totals across the whole store (frozen snapshot). */
  get totals(): Readonly<ProblemTotals> {
    return this.totalsSnapshot;
  }

  /** Number of writes rejected by ownership gating (observability only). */
  get rejectedWriteCount(): number {
    return this.rejectedWrites;
  }

  /** Wipe everything. Used for engine reset and tests. */
  clear(): void {
    this.byFile.clear();
    this.ownerByFile.clear();
    this.summaryByFile.clear();
    this.totalsSnapshot = Object.freeze({ errors: 0, warnings: 0, info: 0 });
    this.rejectedWrites = 0;
  }

  private getOrCreateProviders(key: string): Map<string, ProviderFileState> {
    let providers = this.byFile.get(key);
    if (!providers) {
      providers = new Map();
      this.byFile.set(key, providers);
    }
    return providers;
  }

  private applyFileUpdate(
    uri: Uri,
    key: string,
    providerId: string,
    providers: Map<string, ProviderFileState>,
  ): void {
    const owner = this.ownerByFile.get(key);
    if (owner !== undefined && owner !== providerId) {
      this.rejectedWrites += 1;
      return;
    }
    this.recomputeFileSummary(key);
    const diagnostics = providers.get(providerId)?.diagnostics ?? Object.freeze([]);
    this.diagnosticsChangedEmitter.fire({ uri, providerId, diagnostics });
  }

  private getFileSummary(key: string): ProblemSummary {
    return this.summaryByFile.get(key) ?? ZERO_PROBLEM_STATE;
  }

  private recomputeFileSummary(key: string): void {
    const providers = this.byFile.get(key);
    if (!providers) {
      this.removeFileSummary(key);
      return;
    }
    const owner = this.ownerByFile.get(key);
    const visible = owner !== undefined ? providers.get(owner)?.diagnostics : undefined;
    const summary =
      visible !== undefined
        ? summarize(visible)
        : summarize([...providers.values()].flatMap((state) => state.diagnostics));
    this.updateTotals(key, summary);
  }

  private removeFileSummary(key: string): void {
    this.updateTotals(key, ZERO_PROBLEM_STATE);
    this.summaryByFile.delete(key);
  }

  private updateTotals(key: string, newSummary: ProblemSummary): void {
    const previous = this.summaryByFile.get(key) ?? ZERO_PROBLEM_STATE;
    this.summaryByFile.set(key, newSummary);
    const totals = {
      errors: this.totalsSnapshot.errors - previous.errorCount + newSummary.errorCount,
      warnings: this.totalsSnapshot.warnings - previous.warningCount + newSummary.warningCount,
      info: this.totalsSnapshot.info - previous.infoCount + newSummary.infoCount,
    };
    const changed =
      totals.errors !== this.totalsSnapshot.errors ||
      totals.warnings !== this.totalsSnapshot.warnings ||
      totals.info !== this.totalsSnapshot.info;
    if (!changed) {
      return;
    }
    this.totalsSnapshot = Object.freeze(totals);
    this.totalsChangedEmitter.fire({ totals: this.totalsSnapshot });
  }
}
