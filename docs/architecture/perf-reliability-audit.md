# Performance & Reliability Audit — Task 9

Audit-first: every claim below is produced by a test that measures the shipped
artifact (built `dist`), records its numbers as `[AUDIT]` lines, and asserts
behavioral invariants — not invented performance targets. Baselines are
numbers to revisit, not scores to meet.

Suite: `pnpm vitest run` (29 files, 237 tests, ~42s). All green.
Typecheck: `pnpm typecheck` — clean.

---

## 1. What was measured

| Area                                | File                                                 | Recorded baseline                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler storms                    | `packages/scheduler/tests/audit-performance.test.ts` | `storm-1000`: 1000 save events → 2 scans (job-per-capability floor: the in-flight one + one merged), peakQueue 1, 23ms                          |
| Scheduler merging                   | same                                                 | `burst-1000`: 1000 enqueues → 2 jobs executed, 999 merged, peakQueue 1, 263ms; coverage 1000/1000                                               |
| Scheduler merging, multi-capability | same                                                 | `burst-multi-cap`: 303 enqueues across 3 capabilities → 5 scans (one per capability + merged), peakQueue 3                                      |
| Queue bound + overflow              | same                                                 | `queue-bound`: queueSize 10 → 3 overflow drops, peakQueue 10, engine stayed operational                                                         |
| Concurrency                         | same                                                 | `concurrency-*`: cheap 4/4, medium 2/2, expensive 1/1 saturation; cross-class slots never shared; per-provider override respected               |
| Priority / starvation               | same                                                 | `priority`: manual merges into queued saves, lifts them; never starved behind save backlog                                                      |
| Timeouts                            | same                                                 | `timeout-scan`: hung scan failed at 60ms, slot released, health=Failed, engine continued. `timeout-healthcheck`: recovered via retry (3 probes) |
| Crash isolation                     | same                                                 | `crash`: a throwing provider is isolated; engine survives; queued work does not deadlock                                                        |
| Missing dependency                  | same                                                 | `missing-dependency`: 2 probes before retry; recovered after tool appears                                                                       |
| API save storm, real pipeline       | `packages/api/tests/audit-lifecycle.test.ts`         | `api-storm-1000`: 1000 saves-on-save → exactly 1 extra scan, peak 1, 1106ms                                                                     |
| Cache effectiveness                 | same                                                 | `cache`: unchanged saves → 0 rescans; one changed file → exactly that file; README never wakes the scheduler                                    |
| Watcher / disposal                  | same                                                 | `watcher-disposal`: zero scans, zero events after dispose; totals zeroed                                                                        |
| Lifecycle                           | same                                                 | `lifecycle-100` / `lifecycle-500`: dispose leaves the API inert (totals zeroed, no events after dispose), peak running 0                        |
| Rebuild stress                      | same                                                 | `rebuild-50`: 50 engine rebuilds → only one live engine, exactly one pushed event per engine                                                    |
| Store stability                     | `packages/store/tests/audit-stability.test.ts`       | `store-stable`: 1000 rewrites, constant state, zero growth. `store-10k`: 10 100 ops (10 100 total) bounded, exact rejected-write count          |
| Store ownership                     | same                                                 | `store-ownership`: 3 transfers, single owner slot, no dead provider retained                                                                    |
| Runner lifecycle                    | `packages/providers/base/tests/audit-runner.test.ts` | `runner-*`: enoent/retry, success-release, timeout-kill, disposeAll all clean; 5 runs → zero retained children                                  |
| Index scale                         | `packages/workspace-index/tests/audit-scale.test.ts` | `scale-1000/5000/10000`: index build 334/927/1301ms, rewalk 335/1010/1359ms, 0 change events on unchanged re-walk, heap 2.0/5.5/15.9 MB         |
| One-change detection                | same file                                            | exactly one `change` event, precise mtime recorded                                                                                              |

---

## 2. Defects found and fixed (engine)

1. **Stale scan type after a lift-merge** — `scan-scheduler.ts`.
   `makeJob` derives the provider-call `type` from the plan's priority at
   creation. When a manual job merged into a queued save job, the merge
   updated `priority` (snapshot showed `manual`) but kept the old `type`
   (`save`), so the provider was invoked with a stale call type. Fixed by
   recomputing `type` from the merged priority. This is the exact class of
   bug the priority audit exists to catch: the queue _looked_ right while
   execution carried the wrong intent.

2. **No-op re-walk emitted a change event** — `workspace-index.ts`.
   `rebuildDiagnostics` fired `onDidChangeFiles` unconditionally, so every
   unchanged re-walk woke subscribers once with an empty batch (subscribers
   could not distinguish "rebuilt, nothing changed" from an actual signal).
   Fixed: emit only when `changes.length > 0`. The sole production subscriber
   (`diagnostics-api.handleFileChanges`) iterates the batch, so this was safe
   and measurable: `scale-*` now records `changeEvents=0`.

Both fixes are covered by failing-then-passing audit tests.

---

## 3. Audit-test corrections (evidence, not engine)

- The manual workspace scan passes the **workspace root** as its single uri
  (confirmed by trace: `[["pe-dbg-…"]]`), so the fake yields one warning, not
  one per file. Cache-test expectation aligned (`warnings === 2` → `1`).
- Priority test: one running job **per capability** (a second same-capability
  save waits even with two slots). Assertions updated to the real contract:
  b+c merged into one queued save, manual merges into it and lifts it
  (3 uris), the python job stays separate.
- Multi-capability burst: same rule → 3 queued (one per non-running
  capability), 5 executed scans; assertion updated from 1/3 to 3/5.
- Store ownership union fallback: 2 + 7 = 9 (was mislabeled 7).
- Lifecycle tests subscribed _before_ the scan, so the scan's own apply was
  counted as a post-dispose event; corrected to snapshot-at-dispose and
  assert no _additional_ events (same pattern already used for state events).
- `burst-1000`: the first enqueue runs immediately (one-running-per-capability
  again) — 999 merged into the queued job, executed scans = 2.

---

## 4. Contract confirmations (measured, not assumed)

- 1000 saves → at most one extra scan: the debounce/batch/merge chain holds.
- Queued work is bounded, overflow is dropped and reported, never silently
  lost: 2 overflow events then a 3rd drop for an unregistered capability.
- A hung scan or health check fails at the timeout, releases its slot, and
  the engine continues; failures recover via retry.
- Dispose is a hard stop: zero scans, zero events, totals reset — across 500
  create→dispose cycles and 50 adjacent engine rebuilds.
- Large-workspace re-walks are truly no-ops now (0 events, sub-second at 10k
  files, ~16 MB heap growth measured — baseline to revisit, no invented target).

## 5. Re-running

```bash
pnpm build        # audits measure the shipped dist
pnpm vitest run   # 29 files / 237 tests; [AUDIT] lines are the records
pnpm typecheck
```
