# AutoScan Architecture Review — Task 0

## 1. Current System Topology

Three independent subsystems drive badges. They share `ProblemStore` as the
single write surface but have no shared scheduler, no shared queue, and no
shared cancellation protocol.

```
                         ┌─────────────────────────────────────┐
                         │          ProblemStore                │
                         │  (priority-gated write surface)      │
                         └──────▲────────▲──────────▲───────────┘
                                │        │          │
               ┌────────────────┘        │          │
               │                         │          │
  ┌────────────┴──────────┐  ┌──────────┴──────┐  ┌─┴──────────────────┐
  │ AutoScanController    │  │ DiagnosticsMgr   │  │ StartupScanCtrl    │
  │ (save/create/del/rnm)│  │ (realtime diag)  │  │ (one-shot at boot) │
  └──────────┬───────────┘  └──────────┬───────┘  └────────┬───────────┘
             │                         │                   │
             │ refresh()               │ onDidChangeDiag   │ refreshByNames()
             ▼                         ▼                   ▼
  ┌─────────────────────┐    ┌────────────────────┐  ┌─────────────────────┐
  │ TSC / ESLint        │    │ updateUri()        │  │ TSC / ESLint        │
  │ (scanner providers) │    │ → _store.set()    │  │ (scanner providers) │
  └─────────────────────┘    └────────────────────┘  └─────────────────────┘
```

---

## 2. Event Sources

| # | Source | Fires on | Listener | Disposition |
|---|--------|----------|----------|-------------|
| 1 | `workspace.onDidSaveTextDocument` | File saved (disk write) | `AutoScanController.start()` line 32 | Extract extension → `registry.getOwner(ext)` → queue provider → debounce → `provider.refresh()` |
| 2 | `workspace.onDidCreateFiles` | File created (explorer/API) | `AutoScanController.start()` line 35 | Same as #1 |
| 3 | `workspace.onDidDeleteFiles` | File deleted | `AutoScanController.start()` line 40 | Same as #1 |
| 4 | `workspace.onDidRenameFiles` | File renamed (new URI) | `AutoScanController.start()` line 45 | Same as #1 |
| 5 | `languages.onDidChangeDiagnostics` | Language server emits diagnostic snapshot | `DiagnosticsManager.start()` line 185 | `processChanges()` → `updateUri()` → `_store.set()` (synchronous) |
| 6 | `workspace.onDidSaveTextDocument` (second listener) | File saved | `DiagnosticsManager.start()` line 197 | `scheduleSaveReconciliation()` → setTimeout(1500ms) → `runSaveReconciliation()` |
| 7 | `setInterval(reconcileIntervalMs)` | Periodic (default 30s) | `DiagnosticsManager.startReconcileTimer()` line 354 | `runReconcile()` iterates `_ownedUris` → `clearIfOwner()` |
| 8 | Manual "Scan Workspace" button | User clicks toolbar/status bar button | `ScanWorkspaceButton` | `diagProviderManager.refreshAll()` |
| 9 | Config change (`onDidChangeConfig`) | User edits settings.json | `extension.ts` line 322 | `applyConfig()` → if provider re-enabled: `provider.refresh()` directly |
| 10 | Extension activation (one-shot) | Extension loads | `StartupScanController.run()` | `manager.refreshByNames(candidates)` |

**Duplicate save listeners:** Source #1 and #6 both subscribe to
`workspace.onDidSaveTextDocument` independently. The scanner providers' debounce
timers and the DiagnosticsManager's save-reconciliation timers are uncoordinated
and may interleave.

---

## 3. Queues and Debounce Layers

| Layer | What it queues | Granularity | Debounce | Async? |
|-------|---------------|-------------|----------|--------|
| `AutoScanController.queuedProviders` | Provider **names** (Set<string>) | Per-provider, not per-file | Single `setTimeout` (configurable `autoScanDelay`, default 2000ms) — shared across all providers | `_flush()` is `async`, awaits `Promise.all` of all `provider.refresh()` calls |
| `TscDiagnosticProvider._debounceTimer` | Nothing (single-flight) | Self-blocking re-entrancy guard via `_scanning` flag | `refreshDebounceMs` (300ms hard-coded) | `runScan()` is `async` with multiple `await` points |
| `EslintDiagnosticProvider._debounceTimer` | Nothing (single-flight) | Same as TSC | Same 300ms | Same pattern |
| `DiagnosticsManager.pendingSaveRecon` (Map<key, timer>) | Per-URI save-reconciliation timers | Per-URI | Fixed 1500ms per URI | `runSaveReconciliation()` is sync; called from `setTimeout` |
| `DiagnosticsManager.reconcileTimer` | Nothing (full sweep) | All tracked URIs | `setInterval(reconcileIntervalMs)` (default 30s) | `runReconcile()` is sync |

**Critical observation:** There are **four separate debounce layers** stacked
on top of each other:

1. **AutoScanController** debounce (2000ms) — before `provider.refresh()`
2. **Provider's own** `refreshDebounceMs` (300ms) — before `runScan()`
3. **DiagnosticsManager** save-reconciliation (1500ms) — before re-querying VS Code
4. **DiagnosticsManager** periodic reconcile (30s)

Layers 1 and 2 are redundant: the AutoScanner debounces for 2000ms, then calls
`provider.refresh()`, which **re-debounces** for another 300ms before actually
running the scan. The total delay from save to scan start is 2300ms minimum.

---

## 4. Async Boundaries

### AutoScanController._flush()

```
_flush()
  │
  ├─ for (name of names) ──▶ provider.refresh()  ← returns Promise
  │                            │
  │                            └─▶ setTimeout(300ms) ← **async boundary**
  │                                     │
  │                                     └─▶ runScan()
  │                                            │
  │                                            ├─ await projectResolver.resolveAll()
  │                                            ├─ await tscRunner.run()
  │                                            ├─ writeToStore()       ← sync
  │                                            └─ reconcileOwnership()  ← sync
  │
  └─ await Promise.all(promises)
```

The `_flush()` method clears `queuedProviders` at the **start** of execution,
before awaiting the Promises. If a new save arrives during the async scan,
the new provider name is added back to `queuedProviders`. After `Promise.all`
resolves, the `finally` block checks if new providers were queued and schedules
another flush.

### DiagnosticsManager.processChanges()

```
onDidChangeDiagnostics event
  │
  └─▶ processChanges()          ← sync
        │
        └─▶ updateUri()          ← sync
              │
              ├─ getWorkspaceFolder() check    ← returns undefined for non-workspace
              ├─ _store.set()                   ← sync, priority-gated
              └─ trackUri()                     ← sync
```

This path is fully synchronous. No async boundaries — no yields, no awaits.
Each `processChanges()` call runs to completion atomically on the JS event loop.

### DiagnosticsManager.scheduleSaveReconciliation()

```
onDidSaveTextDocument event
  │
  └─▶ scheduleSaveReconciliation(uri)   ← sync, schedules setTimeout
        │
        └─▶ setTimeout(1500ms)           ← async boundary
              │
              └─▶ runSaveReconciliation()  ← sync
                    │
                    ├─ getUriDiagnostics()
                    ├─ clearIfOwner()    ← sync
                    └─ or updateUri()   ← sync
```

### TSC/ESLint runScan() — internal concurrency

Both providers scan multiple projects/folders concurrently:

```
runScan()
  │
  ├─ semaphore = makeSemaphore(maxConcurrentScans)
  │
  └─ Promise.all(projects.map(async (project) =>
       ├─ semaphore.acquire()         ← await
       ├─ tscRunner.run()            ← await (child process)
       ├─ outputParser.parse()       ← sync
       └─ semaphore.release()
     ))
  │
  └─ writeToStore()                  ← sync
  └─ reconcileOwnership()            ← sync
```

The `_scanning` flag prevents re-entrant `runScan()` calls within the
**same** provider instance. A second `refresh()` during an active scan sets
`_pendingRefresh = true`; the `finally` block drains pending refreshes after
the current scan completes.

---

## 5. Cancellation

| What cancels | Where | What it does | Limitation |
|--------------|-------|-------------|------------|
| `AutoScanController._cancelActiveScans()` | Before scheduling a new flush (line 84-86) | Iterates `queuedProviders`, calls `provider.stop()` on any that are scanning | Only cancels providers in `queuedProviders`; if a provider is scanning but NOT in the queue (e.g., StartupScan), it's **not cancelled** |
| `provider.stop()` | Sets `AbortController.abort()`, clears provider debounce timer | Ongoing `tscRunner.run()` / `eslintRunner.run()` child processes receive the abort signal | No graceful drain; mid-parse results are **discarded** — `writeToStore()` is skipped entirely |
| `StartupScanController.cancel()` | Calls `manager.stopAll()` | Stops ALL providers via DPM | Cancels everything, even providers not started by the startup scan |

**Gap:** When `_cancelActiveScans()` fires, `provider.stop()` aborts the running
scan. The `abortController.abort()` fires inside `runScan()`, which reaches the
`if (signal.aborted) return []` check and returns early — **the `finally`
block still executes**, resetting `_scanning = false`. But the `_pendingRefresh`
drain loop re-invokes `runScan()` again — potentially bypassing the cancellation
the caller intended.

---

## 6. Provider Interaction Matrix

| Action | AutoScanController | DiagnosticsManager | StartupScanController |
|--------|-------------------|--------------------|---------------------|
| Save `.ts` file | Queues `tsc` → debounce → `tscProvider.refresh()` | `scheduleSaveReconciliation(uri)` (if owns URI); ignores if `tsc` owns it | — |
| Save `.py` file | No scanner owns `.py` → ignored | If owns URI: `scheduleSaveReconciliation(uri)` → clear badge 1.5s later | — |
| Rename `.ts` → `.js` | Queues `eslint` (new extension) | `processChanges` fires for both old and new URI | — |
| Delete `.ts` file | Queues `tsc` (same as save) | `processChanges` fires with 0 diagnostics for old URI; only clears if active editor | — |
| Config disables ESLint | — | — | — |
| Config **re-enables** ESLint | — | — | — |
| Extension startup | — | `initialize()` → `fullScan()` if diagnostics exist | `refreshByNames(['tsc','eslint'])` |
| Language server emits diagnostics for `.py` | — | `processChanges()` → `updateUri()` → `_store.set()` → badge appears | — |

**Config change vulnerability:** When config disables a provider, `extension.ts`
calls `applyConfig()` which calls `provider.updateConfig()` → sets `_enabled =
false` → calls `_store.releaseOwnership()`. But `AutoScanController` does NOT
know the provider became disabled — if a save event arrives during the brief
window between `updateConfig()` and the next `onFileChanged()`, the provider
may still be queued and flushed. The `provider.refresh()` will then return
immediately due to `if (!this._enabled) return;` — but the scan is wasted work.

---

## 7. Telemetry Surface

The `AutoScannerMonitor` (656 lines) is already wired with:

- `autoscan.fileSaved` — file event → extension → owner → selected/skipped
- `autoscan.queue` — provider added/removed/duplicate
- `autoscan.debounce` — scheduled/cancelled/fired with timing
- `autoscan.flush` — flush begin with provider list
- `autoscan.refresh` — per-provider begin/end with success/error
- `autoscan.flushComplete` — cycle complete with rescheduled flag
- `autoscan.assertion` — stuck-queue, flush-while-flushing

**Limitation:** The monitor **mirrors** the AutoScanController's internal state
by subscribing to the same events — it does not observe the controller directly.
`this.state.queuedProviders` in the monitor is a **copy**, not a reference to
the controller's actual `queuedProviders` set. If the controller's logic
diverges from the monitor's assumption (e.g., the controller clears the queue
at the start of `_flush()` but the monitor clears it on the first scan-progress
event), the telemetry will be **inaccurate**.

Currently observable via Dashboard: statistics, snapshots, internal state sizes,
and the `checkStuckQueue()` 30s assertion.

---

## 8. Identified Issues

### A. Duplicate save listeners (source #1 and #6)

`workspace.onDidSaveTextDocument` is subscribed to twice:
- `AutoScanController.start()` line 32 → triggers scanner providers
- `DiagnosticsManager.start()` line 197 → triggers save-reconciliation

These are uncoordinated. Both fire on the same event. For a `.ts` file:
- AutoScanController queues TSC (debounce 2000ms → refresh 300ms → scan)
- DiagnosticsManager schedules save-recon (1500ms → if owns URI, clear)
  - TSC owns the URI (priority 10 > 5), so `scheduleSaveReconciliation` skips because `!this._ownedUris.has(key)` → **correct behavior, but accidental**

The separation only works because the save-recon path is gated by `_ownedUris`.
If ownership changes (e.g., TSC disabled), the gate fails and both paths fire.

### B. Four stacked debounce layers

Save → [AutoScan 2000ms] → [Provider 300ms] → scan → [DiagnosticsManager 1500ms recon]
→ [Periodic 30s recon]

The provider's own 300ms debounce inside `refresh()` is redundant when the
AutoScanner has already debounced for 2000ms. Total: 2300ms minimum delay
from save to scan.

### C. No cross-provider job deduplication

Saving a `.ts` file and a `.jsx` file at the same time queues `tsc` and `eslint`
independently flushed together via `Promise.all`. Each scan does a
full-workspace scan of ALL projects/folders rather than just the changed file's
project folder. No incremental/"only the file that changed" targeting exists.

### D. Cancellation is lossy and can re-trigger scans

`_cancelActiveScans()` calls `provider.stop()`, which aborts the scan. The
`finally` block inside `runScan()` may then drain `_pendingRefresh` — re-starting
a scan that the caller meant to cancel permanently.

### E. Provider `refresh()` is fire-and-forget with hidden internal timer

`provider.refresh()` returns a Promise that resolves only after
`setTimeout(300ms)` + `runScan()` completes. The AutoScanner debounces for
2000ms and then calls `refresh()`, which **adds another 300ms** of hidden delay.
This makes the effective debounce time non-obvious and hard to reason about.

### F. No scheduling for non-scanner, non-realtime events

Rename and delete events go through `AutoScanController.onFileChanged()`,
which only queues the **new URI's owner**. Nobody reads the **old URI** to
clear its badge — that work falls to the periodic reconcile timer or the
reactive `processChanges()` path, which only fires if VS Code emits a diagnostic
change event for the old URI.

### G. The `refreshAll()` / `refreshByNames()` path bypasses AutoScanController entirely

When the user clicks "Scan Workspace", `ScanWorkspaceButton` calls
`diagProviderManager.refreshAll()` directly. If the AutoScanController is
mid-flush, two independent invocations of `provider.refresh()` can happen.

The provider's `_scanning` flag prevents two actual `runScan()` executions, but
the `refresh()` method will set `_pendingRefresh = true` — meaning the second
invocation will be deferred and **cannot be cancelled** by the AutoScanner if it
later decides to cancel.

---

## 9. Summary: What to Preserve, What to Replace

### Keep (proven architecture)
- `ProblemStore` as the single write surface with priority gate
- `_scanning` + `_pendingRefresh` per-provider single-flight protection
- `clearIfOwner` owner-aware clearing primitive
- `writeToStore` + `_lastScanUris` reconciliation pattern (scanner providers)
- `DiagnosticsManager._ownedUris` tracking + periodic reconcile (vscodeDiagnostics)
- `onDidChangeDiagnostics` → `updateUri()` reactive path (synchronous, atomic)
- `_store.set()` priority gate

### Replace (the scheduler redesign target)
- AutoScanController's 4-subscription + single-queue + 2000ms debounce
- Provider's internal 300ms debounce inside `refresh()` (redundant with scheduler)
- `_cancelActiveScans()` lossy cancellation
- Duplicate `onDidSaveTextDocument` subscriptions (AutoScan + DiagnosticsManager)
- No file-level / project-level targeting (every scan is full-workspace)
- `refreshAll()` / "Scan Workspace" bypass of the scheduler
- No cross-subsystem coordination (AutoScanner, DiagnosticsManager, StartupScan run independently)
