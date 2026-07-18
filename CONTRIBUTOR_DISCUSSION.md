# Contributor Discussion: Current State & Telemetry Framework Proposal

> **Purpose:** Bring contributors up to speed on critical bugs found, the current v0.8.0 state, and a proposed telemetry framework to eliminate guesswork debugging.

---

## Part 1: Two Critical Bugs Found & Fixed

### Bug A — `isConfigError` false positive in `TscDiagnosticProvider.ts:416`

**File:** `src/providers/TscDiagnosticProvider.ts:412-421`

The original code used `.includes('parse')` to detect config-related TSC errors:

```typescript
private isConfigError(err: TscError): boolean {
    return err.output?.includes('parse'); // BUG: matches "parser.ts"
}
```

This matched **any filename containing "parse"** (e.g., `parser.ts`, `parse-utils.ts`), causing every TSC scan to be classified as a "config error" — the output was discarded, the store remained empty, and no decorations appeared.

**Fix:** Word-boundary regex: `/\bparse\b/`

### Bug B — Missing `fireDidChange(undefined)` after provider registration

**File:** `src/extension.ts:~225`

`registerFileDecorationProvider` ran before TSC populated the store, but no `fireDidChange(undefined)` followed. VS Code never re-queried decorations after the store was populated:

```typescript
// Before (broken):
context.subscriptions.push(
    window.registerFileDecorationProvider(decorationEngine)
);
// No fireDidChange → VS Code never re-queries

// After (fixed):
context.subscriptions.push(
    window.registerFileDecorationProvider(decorationEngine)
);
setTimeout(() => decorationEngine.fireDidChange(undefined), 100);
```

### Bonus Bug: `typeof` check in log line

`onDidChangeFileDecorations is Event` check used `typeof === 'object'` instead of `=== 'function'`, so it always logged `NO`.

**Both Bug A and Bug B are fixed in the current `v0.8.0` build.**

---

## Part 2: The v0.8.0 "Not Working" Mystery

### What we know

- A clean `v0.8.0` was built with both fixes above.
- User installed it but reported "nothing worked" — no badges appeared.
- However, the **debug logs** (added via an OutputChannel in a separate diagnostic build) show the extension is functioning correctly:
  - `fullScan()` completes
  - Store has 7–9 entries after scan
  - `provideFileDecoration` is called and returns badges for ~13–22 items
  - `fireDidChange(undefined)` fires
  - The full chain completes

### Potential explanations

| Hypothesis | Likelihood | Explanation |
|---|---|---|
| **Stale install** | High | User installed the diagnostic build first, then reinstalled clean v0.8.0 without a full "Developer: Reload Window" between. VS Code may have cached the old extension bundle. |
| **VSIX install path** | Medium | Installing from file vs. marketplace behaves differently. The file may not have been copied to the correct extensions folder (`~/.vscode/extensions/`). |
| **Extension host crash** | Low | If the extension throws during `activate()`, VS Code silently disables it. But the logs show activation completed. |
| **VS Code version** | Low | `FileDecorationProvider` API was finalized in 1.89. The current VS Code version should support it. |

### How to verify

1. **Force reinstall:** `code --install-extension problem-explorer-0.8.0.vsix --force`
2. **Reload completely:** "Developer: Reload Window" after install
3. **Check "Show Running Extensions":** Confirm Problem Explorer is listed
4. **Check output channel:** View → Output → dropdown → "Problem Explorer"
5. **Manual refresh:** `Ctrl+Shift+P` → "Problem Explorer: Refresh"

### What we can't explain

If steps 1–5 all pass and the store has entries but badges still don't appear, there may be a deeper VS Code API issue — possibly a **URI normalization mismatch** between the URIs we pass to `fireDidChange` and the URIs VS Code uses internally when calling `provideFileDecoration`. The telemetry framework (proposed below) is designed to catch exactly these kinds of cross-boundary issues.

---

## Part 3: Telemetry Framework Proposal — Architecture

### Why

We've spent hours debugging by reading code and adding `console.log` statements. This is slow, fragile, and doesn't capture the full picture. A proper monitoring framework would:

- **Confirm** that events fire in the expected order
- **Detect** when a step is skipped or the pipeline stalls
- **Measure** timing (latency between diagnostic change and decoration update)
- **Record** the exact URI strings flowing across each boundary (to catch normalization mismatches)
- **Surface** the state of the store, cache, and decorations at any point in time

### Design: 5 Phases, 31 Monitors

#### Phase 1 — Core Infrastructure (7 monitors, Priority: Critical)

The foundation that all other monitors depend on.

| # | Monitor | What it watches | Why |
|---|---|---|---|
| 1.1 | **ExtensionLifecycle** | `activate()` / `deactivate()` calls, startup duration | Confirm extension loads |
| 1.2 | **ConfigMonitor** | `problemExplorer.*` setting reads and changes | Catch misconfigured settings |
| 1.3 | **StoreMonitor** | `ProblemStore` mutations: `set`, `delete`, `clear`, `batch` | Is data making it into the store? |
| 1.4 | **StoreSnapshot** | Periodic full `snapshot()` dump (every 30s) | What does the store actually contain? |
| 1.5 | **TimerMonitor** | `setTimeout`, `setInterval` creation and firing | Are scheduled callbacks firing? |
| 1.6 | **ErrorMonitor** | Uncaught exceptions, promise rejections, `try/catch` blocks | Catch silent failures |
| 1.7 | **TelemetryHealth** | Heartbeat from TelemetryBus itself | Is the monitoring system alive? |

#### Phase 2 — Scan Pipeline (7 monitors, Priority: Critical)

Tracks every step from diagnostic source → store → decoration.

| # | Monitor | What it watches | Why |
|---|---|---|---|
| 2.1 | **AutoScannerMonitor** | Scan cycle: start, progress, end, timeout | Is the scanner running? |
| 2.2 | **TscProviderMonitor** | TSC process: spawn, stdout, stderr, exit code, parse errors | Is TSC output being parsed correctly? |
| 2.3 | **VsDiagProviderMonitor** | `onDidChangeDiagnostics` events + `flushUpdates` | Are VS Code diagnostics flowing through? |
| 2.4 | **ScanDurationMonitor** | Time per scan cycle | Detect slow scans (>5s) |
| 2.5 | **DecorationEngineMonitor** | `provideFileDecoration` calls, return values, `fireDidChange` | Is the decoration pipeline active? |
| 2.6 | **FolderMonitor** | Folder aggregate computation | Are folder statuses being computed? |
| 2.7 | **PipelineLatencyMonitor** | Full chain: diagnostic change → decoration update | End-to-end timing |

#### Phase 3 — Cross-Boundary Integrity (5 monitors, Priority: High)

Catches mismatches between internal state and VS Code API expectations.

| # | Monitor | What it watches | Why |
|---|---|---|---|
| 3.1 | **UriNormalizationMonitor** | URI strings across all boundaries (store keys, `fireDidChange`, `provideFileDecoration`) | Catch encoding/casing mismatches |
| 3.2 | **EventCounterMonitor** | Event sequence numbers and ordering | Detect skipped or duplicate events |
| 3.3 | **StoreConsistencyMonitor** | Cross-check `ProblemStore` vs `languages.getDiagnostics()` | Detect stale or missing store entries |
| 3.4 | **CacheConsistencyMonitor** | Cross-check `ProblemCache` vs `ProblemStore` | Detect drift between cache and store |
| 3.5 | **DecorationVsStoreMonitor** | Compare `provideFileDecoration` output vs store state | Detect decoration mismatches |

#### Phase 4 — Resource & Performance (6 monitors, Priority: Medium)

| # | Monitor | What it watches | Why |
|---|---|---|---|
| 4.1 | **MemoryMonitor** | Store/cache entry count, total size | Detect memory leaks |
| 4.2 | **DisposalMonitor** | Track `Disposable` registration and disposal | Prevent resource leaks |
| 4.3 | **SubscriptionMonitor** | Count of active `onDidChange*` subscribers | Detect subscriber leaks |
| 4.4 | **DebounceMonitor** | Debounce call creation, flush, cancel | Is debounce behaving correctly? |
| 4.5 | **BatchMonitor** | Batch `begin`/`end` pairs, coalesced events | Are batches properly balanced? |
| 4.6 | **RecoveryMonitor** | Self-healing attempts, error recovery | Track stability |

#### Phase 5 — Diagnostics (6 monitors, Priority: Low)

| # | Monitor | What it watches | Why |
|---|---|---|---|
| 5.1 | **DiagnosticCountMonitor** | Total diagnostic count over time | Track workspace health trends |
| 5.2 | **ProviderHealthMonitor** | `IProblemProvider` lifecycle (start/stop/dispose) | Are providers alive? |
| 5.3 | **WorkspaceMonitor** | Folder add/remove events | Multi-root correctness |
| 5.4 | **IgnoredFileMonitor** | Files matched by ignore patterns | Verify ignore filter correctness |
| 5.5 | **StatusBarMonitor** | Status bar updates | Is the status bar in sync? |
| 5.6 | **ApiMonitor** | External API calls (`getProblemState`, `onDidChangeProblemState`) | Track API usage |

### Key Design Decisions

**Why a bus, not direct logging?**
A `TelemetryBus` centralizes all monitoring data. Monitors push structured events (typed, timestamped) to the bus. A single `TelemetryReporter` subscribes to the bus and handles output (console, output channel, diagnostic file). This keeps monitors decoupled from output format.

**Why typed events, not plain strings?**
Each monitor defines its own event types (e.g., `StoreSetEvent { uri: string, state: ProblemState }`). This makes filtering, searching, and programmatic analysis possible.

**Why 5 phases?**
Phase 1 (Core) + Phase 2 (Scan) are Critical — they cover the pipeline that is currently broken. Phase 3 (Integrity) is High — it catches the subtle mismatches that are hard to find. Phases 4–5 are Medium/Low — valuable but not blocking.

### Implementation Order

```
Week 1: Phase 1 (Core) + TelemetryBus + TelemetryConfig
Week 2: Phase 2 (Scan Pipeline) + Phase 3 (Integrity)
Week 3: Phase 4 (Resource) + Phase 5 (Diagnostics)
```

Each phase is independently shippable — you get value after Week 1.

### Open Questions for Contributors

1. **Scope creep:** 31 monitors is a lot. Should we start with Phase 1 + Phase 2 (14 monitors, Critical priority) and defer the rest?
2. **Persistence:** Should telemetry data survive extension restarts (write to globalState / disk), or is it purely in-memory?
3. **User-facing toggle:** Should there be a `problemExplorer.telemetry.enabled` setting, or is this purely a dev tool?
4. **The v0.8.0 mystery:** Before building telemetry, should we invest 1–2 hours attempting to reproduce the "not working" scenario with a clean install? It might reveal a simple fix and make the telemetry framework less urgent.
