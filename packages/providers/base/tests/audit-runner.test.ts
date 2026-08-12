// TASK 9 — Child-process resource audit for the provider runner.
// Regression: a failed spawn (ENOENT) must not accumulate `ChildProcess`
// objects in the module-level active set — only 'exit' used to remove them,
// and 'exit' never fires for a failed spawn. Also: successive scans release
// their children, timeouts release theirs, and disposeAllChildren clears.

import { describe, expect, it } from 'vitest';
import { activeChildCount, disposeAllChildren, runExecutable } from '../src/runner.js';

function record(key: string, value: unknown): void {
  console.log(`[AUDIT] ${key}=${value}`);
}

const SLEEP_SCRIPT = 'setTimeout(() => { console.log("done"); process.exit(0); }, 350);';

describe('Task9 audit — runner resource safety', () => {
  it('ENOENT spawn leaves no retained child: 5 missing runs, zero accumulation', async () => {
    expect(activeChildCount()).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      const result = await runExecutable([`definitely-missing-audit-bin-${i}`], {
        timeoutMs: 1000,
      });
      expect(result.missing).toBe(true);
    }
    // The failed spawn objects must be released even though 'exit' never fired.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(activeChildCount()).toBe(0);
    record('runner-enoent', 'runs=5 retainedChildren=0 growth=0');
  });

  it('successive scans track and release their children', async () => {
    expect(activeChildCount()).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      const run = runExecutable([process.execPath, '-e', SLEEP_SCRIPT], { timeoutMs: 2000 });
      // Mid-run: exactly one child is tracked.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activeChildCount()).toBe(1);
      const result = await run;
      expect(result.code).toBe(0);
      // After the run: released.
      expect(activeChildCount()).toBe(0);
    }
    record('runner-success', 'scans=3 peakTracked=1 releasedAfterEach=true');
  });

  it('timed-out children are released after kill', async () => {
    expect(activeChildCount()).toBe(0);
    const result = await runExecutable([process.execPath, '-e', SLEEP_SCRIPT], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(activeChildCount()).toBe(0);
    record('runner-timeout', 'killed=true releasedAfterKill=true');
  });

  it('disposeAllChildren clears the active set', async () => {
    disposeAllChildren(); // baseline hygiene
    const run = runExecutable([process.execPath, '-e', SLEEP_SCRIPT], { timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeChildCount()).toBe(1);
    disposeAllChildren();
    expect(activeChildCount()).toBe(0);
    const result = await run;
    expect(result.code).not.toBe(0); // killed before finishing
    record('runner-disposeAll', 'cleared=true');
  });
});
