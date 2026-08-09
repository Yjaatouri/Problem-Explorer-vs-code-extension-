import { describe, expect, it } from 'vitest';

import { ProblemSeverity } from '@pe/core';

import type { ProblemSummary } from '@pe/api';
import type { ExtensionConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { DecorationEngine } from '../src/decorations.js';
import type { DecorationUriLike } from '../src/decorations.js';

function withConfig(overrides: Partial<ExtensionConfig>): ExtensionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function summary(severity: ProblemSeverity, overrides: Partial<ProblemSummary> = {}): ProblemSummary {
  return {
    severity,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    fileCount: 1,
    ...overrides,
  };
}

function uri(fsPath: string): DecorationUriLike {
  return {
    fsPath,
    path: fsPath.replace(/\\/g, '/'),
    toString: () => fsPath,
  };
}

function makeEngine(config: ExtensionConfig) {
  const summaries = new Map<string, ProblemSummary>();
  const engine = new DecorationEngine(
    { getProblems: (u) => summaries.get((u as { fsPath: string }).fsPath) },
    () => true,
  );
  engine.setConfig(config);
  return { engine, summaries };
}

describe('DecorationEngine', () => {
  it('hides badges when disabled', () => {
    const { engine, summaries } = makeEngine(withConfig({ enabled: false }));
    summaries.set('a.ts', summary(ProblemSeverity.Error));
    expect(engine.provideFileDecoration(uri('a.ts'))).toBeUndefined();
  });

  it('no badge without a summary', () => {
    const { engine } = makeEngine(withConfig({ enabled: true }));
    expect(engine.provideFileDecoration(uri('no.ts'))).toBeUndefined();
  });

  it('renders error badge with letter style by default', () => {
    const { engine, summaries } = makeEngine(withConfig({ enabled: true }));
    summaries.set('a.ts', summary(ProblemSeverity.Error, { errorCount: 5 }));
    const deco = engine.provideFileDecoration(uri('a.ts'));
    expect(deco?.badge).toBe('E');
    expect(deco?.color).toBe('problemExplorer.errorForeground');
    expect(deco?.tooltip).toBe('5 errors');
  });

  it('count style caps at 9+ for three-digit counts', () => {
    const { engine, summaries } = makeEngine(withConfig({ badgeStyle: 'count' }));
    summaries.set('a.ts', summary(ProblemSeverity.Error, { errorCount: 12 }));
    expect(engine.provideFileDecoration(uri('a.ts'))?.badge).toBe('12');
    summaries.set('b.ts', summary(ProblemSeverity.Error, { errorCount: 123 }));
    expect(engine.provideFileDecoration(uri('b.ts'))?.badge).toBe('9+');
  });

  it('showWarnings=false hides warning-only files', () => {
    const { engine, summaries } = makeEngine(withConfig({ showWarnings: false }));
    summaries.set('w.ts', summary(ProblemSeverity.Warning, { warningCount: 1 }));
    expect(engine.provideFileDecoration(uri('w.ts'))).toBeUndefined();
  });

  it('aggregate tooltip includes file count', () => {
    const { engine, summaries } = makeEngine(withConfig({}));
    summaries.set('folder', summary(ProblemSeverity.Warning, { warningCount: 4, fileCount: 3 }));
    expect(engine.provideFileDecoration(uri('folder'))?.tooltip).toBe(
      '4 warnings, across 3 files',
    );
  });

  it('coalesces change events into a single fire', async () => {
    const { engine } = makeEngine(withConfig({}));
    const fired: unknown[] = [];
    engine.setUpdater((uris) => fired.push(uris));
    engine.notifyChanged([uri('a.ts')]);
    engine.notifyChanged([uri('b.ts')]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toHaveLength(2);
  });
});