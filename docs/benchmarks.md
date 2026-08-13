# Engine Benchmarks — M7 evidence

Measured on Windows 11 (NTFS), Node 20, release build (`pnpm build`), synthetic
workspaces under a temp directory. Every number below is a recorded `[AUDIT]`
line from the suites, reproduced exactly — baselines to revisit, not invented
targets. Nothing here is a pass/fail judgment.

**How to reproduce:**

```bash
pnpm build
pnpm vitest run packages/workspace-index/tests/audit-scale.test.ts   # index-level
pnpm vitest run packages/api/tests/audit-startup.test.ts              # API-level
```

---

## 1. Index level — build, re-walk, memory

`WorkspaceIndex` over `fileCount` files (90% .ts / 10% .py across 25 buckets):
first `load + rebuildDiagnostics` (index build), then an unchanged re-walk.
"Re-walk" includes both full directory walks; `changeEvents` = events emitted
on the unchanged re-walk (must be zero — nothing changed).

| files  | indexMs | rewalkMs | changeEvents | heapDeltaMb |
| ------ | ------- | -------- | ------------ | ----------- |
| 1,000  | 96      | 75       | 0            | 2.0         |
| 5,000  | 286     | 274      | 0            | 5.6         |
| 10,000 | 475     | 491      | 0            | 15.8        |
| 50,000 | 2,697   | 2,562    | 0            | 19.8        |

Per-file cost stays flat or improves with size (50k build ≈ 0.054 ms/file vs
0.096 ms/file at 1k) — the walk is stat-dominated, not per-file-diff dominated.
Heap growth at 50k was 19.8 MB over an already-loaded process.

**One changed file among 1,000** (mtime bump only): exactly one `change` event,
the entry's `modifiedMs` matches disk. No false positives, no misses.

## 2. API level — startup, scan latency

`DiagnosticsAPI` (index → analyzer → scheduler → store) with an in-process
fake provider whose scan is instant — so all numbers below isolate **engine
overhead only**; external tool cost (tsc/eslint/ruff) is not measured here.
Boot mirrors the extension: construct (synchronous index walk) → provider
Ready → `ScanType.Startup`.

Latency is measured to **full quiet**: running = 0 **and** no new scan within
a 300 ms grace window. `*Calls` = number of provider invocations per phase,
`*Uris` = total uris handed to the provider across those calls (the real work
the engine performed).

| files  | constructMs | startupMs | scanMs | incrementalMs | heapDeltaMb |
| ------ | ----------- | --------- | ------ | ------------- | ----------- |
| 1,000  | 83          | 435       | 347    | 336           | 6.0         |
| 10,000 | 590         | 1,013     | 450    | 483           | 21.8        |
| 50,000 | 2,084       | 2,658     | 734    | 853           | 165.2       |

Scaling: construct is flat per file (0.083 → 0.042 ms/file); workspace and
incremental scans grow sub-linearly (plan construction dominates, dispatch is
constant).

| files  | startupCalls | startupUris | manualCalls | manualUris | incrementalCalls | incrementalUris |
| ------ | ------------ | ----------- | ----------- | ---------- | ---------------- | --------------- |
| 1,000  | 1            | 1           | 2           | 1,001      | 3                | 2,000           |
| 10,000 | 1            | 1           | 2           | 10,001     | 3                | 20,000          |
| 50,000 | 1            | 1           | 2           | 50,001     | 3                | 100,000         |

## 3. Measured finding: duplicate work on requestScan

The call/uri table above is not a rounding artifact — the engine performs
**2-4x the intended work per requestScan**, verified at all three sizes:

- **Startup scan** (no owned files yet): 1 call (the workspace root plan).
- **Workspace manual scan**: 2 calls — the full-file plan (all N files) _and_
  the root workspace plan. Both run because the file plan is dispatched
  immediately on enqueue, before the workspace plan's
  `cancelCoveredFileJobs` can supersede it. Intended work: 1 root scan.
- **100-file incremental scan**: 3 calls and 2,000 uris at 1k / **100,000
  uris at 50k** — the incremental file plan, then a full-workspace re-scan,
  then a second re-scan of everything except the first 100 files. Root cause:
  `requestScan` invalidates the whole cache; each completed scan emits a
  Scanning→Ready status event; the API forwards every status change to
  `analyzer.onProviderHealthChanged`, which re-plans all owned (now stale)
  files. Results are idempotent — the store ends correct — so this is a
  work multiplier, not a correctness bug.

**Recommendation (deferred, per audit-first):** dedupe file plans against a
workspace plan in the same batch, and make the post-scan status re-plan skip
files that a scan just covered. Estimated impact at 50k: incremental scans
drop from ~100k uris to 100; workspace scans from 2 calls to 1.

## 4. What "how does the engine behave at 1k / 10k / 50k?" says

- Index build: **~0.05-0.10 ms per file** — a 50k workspace walks in ~2.7 s.
- Unchanged re-walks: silent (0 events), same order of magnitude as a build.
- Engine startup (construct + first scan): **~0.4 s at 1k, ~1.0 s at 10k,
  ~2.7 s at 50k**.
- Workspace scan: **~350-730 ms** regardless of size (plan construction), but
  with the duplicate-work finding above, actual provider load is ~2x.
- Incremental (100 files): **~340-850 ms** engine time — and up to 2,000x the
  intended provider load at 50k (finding in §3).
- Memory: ~2-20 MB heap delta for the index at 1k-50k; API-level runs add the
  materialized per-file diagnostics (fake) — ~165 MB at 50k in this fixture.
- One changed file: exactly one change event, exact mtime recorded.
