import { ProblemSeverity } from '@pe/core';
import type { Diagnostic, Uri } from '@pe/core';
import { ProblemStore } from '../src/store.js';
import { describe, expect, it } from 'vitest';

function testUri(fsPath: string): Uri {
  const normalized = fsPath.replace(/\\/g, '/');
  return {
    scheme: 'file',
    authority: '',
    path: normalized,
    fsPath,
    toString: () => `file:///${normalized}`,
    with: (change) => testUri(change.path ?? fsPath),
  };
}

const FILE_A = testUri('/home/user/proj/src/app.ts');
const FILE_B = testUri('/home/user/proj/src/util.ts');
const FILE_C = testUri('/home/user/proj/test/app.test.ts');
const FOLDER_SRC = testUri('/home/user/proj/src');

function diagnostic(severity: ProblemSeverity, message = 'msg', source = 'tsc'): Diagnostic {
  return { line: 0, column: 0, severity, message, source };
}

describe('ProblemStore', () => {
  describe('setDiagnostics / getSummary', () => {
    it('tracks counts and worst severity per file', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [
        diagnostic(ProblemSeverity.Error),
        diagnostic(ProblemSeverity.Warning),
        diagnostic(ProblemSeverity.Info),
      ]);
      const summary = store.getSummary(FILE_A);
      expect(summary.errorCount).toBe(1);
      expect(summary.warningCount).toBe(1);
      expect(summary.infoCount).toBe(1);
      expect(summary.severity).toBe(ProblemSeverity.Error);
      expect(summary.fileCount).toBe(1);
    });

    it('returns the zero state for unknown files', () => {
      const store = new ProblemStore();
      const summary = store.getSummary(FILE_A);
      expect(summary.errorCount).toBe(0);
      expect(summary.severity).toBe(ProblemSeverity.None);
      expect(summary.fileCount).toBe(0);
    });

    it('an empty write clears the file summary', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      store.setDiagnostics('tsc', FILE_A, []);
      expect(store.getSummary(FILE_A).errorCount).toBe(0);
      expect(store.getSummary(FILE_A).fileCount).toBe(0);
    });
  });

  describe('totals', () => {
    it('aggregates running totals across files', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [
        diagnostic(ProblemSeverity.Error),
        diagnostic(ProblemSeverity.Error),
      ]);
      store.setDiagnostics('tsc', FILE_B, [diagnostic(ProblemSeverity.Warning)]);
      expect(store.totals.errors).toBe(2);
      expect(store.totals.warnings).toBe(1);
      expect(store.totals.info).toBe(0);
    });

    it('reverts totals on removeDiagnostics', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      store.removeDiagnostics('tsc', FILE_A);
      expect(store.totals.errors).toBe(0);
    });

    it('totals snapshot is frozen', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      expect(Object.isFrozen(store.totals)).toBe(true);
    });
  });

  describe('ownership gating', () => {
    it('applies writes while unowned', () => {
      const store = new ProblemStore();
      store.setDiagnostics('realtime', FILE_A, [diagnostic(ProblemSeverity.Warning)]);
      expect(store.getSummary(FILE_A).warningCount).toBe(1);
    });

    it('rejects writes from a non-owner provider', () => {
      const store = new ProblemStore();
      store.recordOwner(FILE_A, 'tsc');
      store.setDiagnostics('realtime', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      expect(store.getSummary(FILE_A).errorCount).toBe(0);
      expect(store.getSummary(FILE_A).severity).toBe(ProblemSeverity.None);
      expect(store.rejectedWriteCount).toBe(1);
      expect(store.totals.errors).toBe(0);
    });

    it('applies writes from the owner provider', () => {
      const store = new ProblemStore();
      store.recordOwner(FILE_A, 'tsc');
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      expect(store.getSummary(FILE_A).errorCount).toBe(1);
    });

    it('ownership transfer swaps visible state atomically', () => {
      const store = new ProblemStore();
      store.recordOwner(FILE_A, 'realtime');
      store.setDiagnostics('realtime', FILE_A, [diagnostic(ProblemSeverity.Warning)]);
      expect(store.getSummary(FILE_A).severity).toBe(ProblemSeverity.Warning);

      store.recordOwner(FILE_A, 'tsc');
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      expect(store.getSummary(FILE_A).severity).toBe(ProblemSeverity.Error);
      expect(store.totals.errors).toBe(1);
      expect(store.totals.warnings).toBe(0);
      expect(store.getOwners(FILE_A)).toEqual(['tsc']);
    });

    it('shows the previous owners data when ownership returns', () => {
      const store = new ProblemStore();
      store.recordOwner(FILE_A, 'tsc');
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      store.recordOwner(FILE_A, 'realtime');
      store.setDiagnostics('realtime', FILE_A, [diagnostic(ProblemSeverity.Warning)]);
      expect(store.getSummary(FILE_A).severity).toBe(ProblemSeverity.Warning);

      store.recordOwner(FILE_A, 'tsc');
      expect(store.getSummary(FILE_A).severity).toBe(ProblemSeverity.Error);
    });

    it('recordOwner with undefined releases ownership and falls back to the union', () => {
      const store = new ProblemStore();
      store.recordOwner(FILE_A, 'tsc');
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      store.recordOwner(FILE_A, undefined);
      expect(store.getOwners(FILE_A)).toEqual([]);
      store.setDiagnostics('realtime', FILE_A, [diagnostic(ProblemSeverity.Info)]);
      expect(store.getSummary(FILE_A).severity).toBe(ProblemSeverity.Error);
    });
  });

  describe('folder summaries', () => {
    it('aggregates descendants, worst severity wins', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [
        diagnostic(ProblemSeverity.Error),
        diagnostic(ProblemSeverity.Info),
      ]);
      store.setDiagnostics('tsc', FILE_B, [diagnostic(ProblemSeverity.Warning)]);
      const summary = store.getFolderSummary(FOLDER_SRC);
      expect(summary.errorCount).toBe(1);
      expect(summary.warningCount).toBe(1);
      expect(summary.infoCount).toBe(1);
      expect(summary.fileCount).toBe(2);
      expect(summary.severity).toBe(ProblemSeverity.Error);
    });

    it('does not include files outside the folder', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_C, [diagnostic(ProblemSeverity.Error)]);
      expect(store.getFolderSummary(FOLDER_SRC).errorCount).toBe(0);
    });
  });

  describe('getDiagnostics', () => {
    it('returns the union across providers', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error, 'tsc msg', 'tsc')]);
      store.setDiagnostics('eslint', FILE_A, [
        diagnostic(ProblemSeverity.Warning, 'eslint msg', 'eslint'),
      ]);
      const all = store.getDiagnostics(FILE_A);
      expect(all).toHaveLength(2);
      expect(all.some((d) => d.source === 'tsc')).toBe(true);
      expect(all.some((d) => d.source === 'eslint')).toBe(true);
    });

    it('returns a frozen snapshot', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      const all = store.getDiagnostics(FILE_A);
      expect(Object.isFrozen(all)).toBe(true);
      expect(() => (all as Diagnostic[]).push(diagnostic(ProblemSeverity.Error))).toThrow(
        TypeError,
      );
    });
  });

  describe('events', () => {
    it('fires diagnosticsChanged on applied writes only', () => {
      const store = new ProblemStore();
      const events: string[] = [];
      store.onDiagnosticsChanged((event) =>
        events.push(`${event.providerId}:${event.diagnostics.length}`),
      );
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      store.recordOwner(FILE_A, 'tsc');
      store.setDiagnostics('realtime', FILE_A, [diagnostic(ProblemSeverity.Info)]);
      expect(events).toEqual(['tsc:1']);
    });

    it('fires totalsChanged when totals change', () => {
      const store = new ProblemStore();
      const seen: number[] = [];
      store.onTotalsChanged((event) => seen.push(event.totals.errors));
      store.setDiagnostics('tsc', FILE_A, [
        diagnostic(ProblemSeverity.Error),
        diagnostic(ProblemSeverity.Warning),
      ]);
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      expect(seen).toEqual([1, 1]);
      expect(store.totals.warnings).toBe(0);
    });

    it('fires ownershipChanged on transfer', () => {
      const store = new ProblemStore();
      const events: Array<{ from?: string; to?: string }> = [];
      store.onOwnershipChanged((event) =>
        events.push({ from: event.previousProviderId, to: event.providerId }),
      );
      store.recordOwner(FILE_A, 'realtime');
      store.recordOwner(FILE_A, 'tsc');
      store.recordOwner(FILE_A, 'tsc');
      expect(events).toEqual([
        { from: undefined, to: 'realtime' },
        { from: 'realtime', to: 'tsc' },
      ]);
    });
  });

  describe('clear', () => {
    it('wipes all state', () => {
      const store = new ProblemStore();
      store.setDiagnostics('tsc', FILE_A, [diagnostic(ProblemSeverity.Error)]);
      store.recordOwner(FILE_A, 'tsc');
      store.clear();
      expect(store.getSummary(FILE_A).errorCount).toBe(0);
      expect(store.getOwners(FILE_A)).toEqual([]);
      expect(store.totals.errors).toBe(0);
      expect(store.rejectedWriteCount).toBe(0);
    });
  });
});
