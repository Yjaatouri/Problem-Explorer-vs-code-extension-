# Problem Explorer — Architecture

## Overview

Problem Explorer overlays diagnostic information (errors, warnings, info) directly onto files and folders in the VS Code Explorer view using the `FileDecorationProvider` API. It reads diagnostics from `languages.getDiagnostics()`, normalizes them into `ProblemStore` (the single source of truth), and renders badges/colors through file decorations.

---

## Architecture Diagram

```
  Source Layer
  ┌───────────────────────────────────────────────┐
  │  VS Diagnostics Provider    ESLint   Python    │
  │  (wraps languages.onDidChangeDiagnostics)      │
  └───────────────────────┬───────────────────────┘
                          │ writes ProblemState
                          v
  Store Layer  (Phase 1 — Single Source of Truth)
  ┌───────────────────────────────────────────────┐
  │  ProblemStore  ───  Map<uri, ProblemState>     │
  │  Events: added/updated/removed/cleared/batch   │
  └────────┬──────────────────────┬───────────────┘
           │ reads                │ reads
           v                      v
  ┌────────────────┐    ┌──────────────────────────┐
  │ DecorationEngine│    │ FolderStatusManager      │
  │ (FileDecoration │    │ (folder aggregation via  │
  │  Provider)      │    │  aggregateStatuses())    │
  └────────┬───────┘    └────────┬─────────────────┘
           │                     │
           v                     v
  ┌────────────────┐    ┌──────────────────────────┐
  │ VS Code        │    │ ApiManager                │
  │ File Explorer  │    │ (public API for other     │
  │ (badge + color)│    │  extensions)              │
  └────────────────┘    └──────────────────────────┘

  Legacy Sync (writes only — no production reads)
  ┌───────────────────────────────────────────────┐
  │  ProblemCache (2-level Map, LRU eviction)      │
  │  Written by: Provider, FolderStatusManager     │
  │  Remaining reads: DiagnosticsManager.getStatus │
  │                   CacheProblemProvider         │
  │                   (both dead code, never called)│
  └───────────────────────────────────────────────┘
```

---

## Major Components

### Extension Core (`src/extension.ts`)
- Activation entry point. Creates the service graph, wires dependencies, registers disposables.
- Creates `DiagnosticsManager`, `ProblemCache`, `DecorationEngine`, `FolderStatusManager`, `ConfigManager`, `WorkspaceManager`, `ApiManager`.

### ConfigManager (`src/config/configManager.ts`)
- Reads `problemExplorer.*` settings from VS Code configuration.
- Fires `onDidChangeConfig` when relevant settings change.

### DiagnosticsManager (`src/diagnostics/diagnosticsManager.ts`)
- Subscribes to `languages.onDidChangeDiagnostics`.
- Ingests `Diagnostic[]` per URI and converts to `ProblemState` via `toProblemState()`.
- Writes results into `ProblemCache` (legacy path).
- Guards against transient zero-diagnostic clears (active-editor check).

### VSDiagnosticsProvider (`src/providers/VSDiagnosticsProvider.ts`) — Phase 3
- Wraps `languages.onDidChangeDiagnostics` as an `IProblemProvider`.
- On diagnostic change: computes `ProblemState` from raw diagnostics via `applySeverityOverrides` + `toProblemState`, then writes to `ProblemStore` (source of truth) and `ProblemCache` (legacy sync).

### ProblemCache (`src/cache/cacheLayer.ts`)
- Two-level `Map<folderKey, Map<uriKey, ProblemState>>`.
- Stores file-level and synthetic folder-aggregate entries.
- Supports `set`, `get`, `delete`, `clear`, `getEntries`, `computeTotals`.
- LRU eviction for large workspaces.
- **Write-only in production** — no active component reads from cache. Remaining `get()` calls are in dead code (`DiagnosticsManager.getStatus`, `CacheProblemProvider`).

### FolderStatusManager (`src/folder/folderStatusManager.ts`)
- Builds a virtual folder tree from file URIs.
- Propagates worst child severity up to parent folders using `aggregateStatuses()`.
- Reads file entries from `ProblemStore.snapshot()` and writes folder aggregates to both ProblemStore and ProblemCache.

### DecorationEngine (`src/decoration/decorationEngine.ts`)
- Implements `FileDecorationProvider.provideFileDecoration`.
- Reads from `ProblemStore` for synchronous URI-to-decoration lookup.
- Falls back to `languages.getDiagnostics(uri)` live query if ProblemStore misses (self-healing).
- Fires `onDidChangeFileDecorations` to invalidate decorations on change.
- Formats tooltip text ("3 errors, 5 warnings across 12 files").

### WorkspaceManager (`src/workspace/workspaceManager.ts`)
- Tracks `workspace.workspaceFolders` changes.
- Triggers rescans when folders are added or removed.

### ApiManager (`src/api/problemExplorerApi.ts`)
- Exposes the public API surface for other extensions: `getProblemState(uri)`, `onDidChangeProblemState`.
- Reads from `ProblemStore` (no longer touches ProblemCache).

### ProblemStore (`src/store/ProblemStore.ts`) — Phase 1
- **Single source of truth** for all decoration, folder, and API reads.
- Synchronous in-memory database: `Map<string, ProblemState>`.
- Discriminated-union events (`added`, `updated`, `removed`, `cleared`, `batch`).
- Batch mutations via `beginBatch()` / `endBatch()`.
- Monotonic version counter (`getVersion()`).
- Frozen `snapshot()` for read-only external access.

### Provider Layer (`src/providers/`, `src/services/ProviderManager.ts`) — Phase 2

**Responsibilities:**
- Abstract the source of problem data behind a common `IProblemProvider` interface.
- Each provider feeds data into `ProblemStore` exclusively — providers never write to `ProblemCache` or update decorations directly.
- `ProviderManager` owns the lifecycle of all registered providers.

**Lifecycle (defined by `IProblemProvider`):**
1. `start()` — begin listening for data from the source.
2. `stop()` — pause listening (retain state, keep subscriptions).
3. `refresh()` — force a full re-scan from the source.
4. `dispose()` — release all resources permanently.

**Base class (`BaseProblemProvider`):**
- Tracks running/disposed state.
- Provides lifecycle hooks (`onStart`, `onStop`, `onRefresh`, `onDispose`) for subclasses.
- `ensureNotDisposed()` guard and `registerDisposable()` helper.

**ProviderManager API:**
- `register(name, provider)` / `unregister(name)` / `get(name)`
- `startAll()` / `stopAll()` / `refreshAll()` / `dispose()`
- All operations are guarded against use-after-dispose.

**Providers (all feed ProblemStore, never decorations):**

| Provider | Source | Description |
|---|---|---|
| VS Diagnostics | `languages.onDidChangeDiagnostics` | Maps VS Code diagnostic events into ProblemState. Writes to both ProblemStore and ProblemCache (Phase 4 — active). |

### Models (`src/models/`)
- `ProblemStoreChange.ts` — event discriminated union for store consumers.

### Additional Modules
- `badgeFormatter` — formats severity+counts into badge letters/numbers/dots.
- `colorProvider` — maps severity to `ThemeColor`.
- `severityMapper` — converts `DiagnosticSeverity` → `ProblemSeverity` with per-extension overrides.
- `ignoreFilter` — pre-compiled glob patterns to skip node_modules etc.
- `propagationStrategy` — `aggregateStatuses()` for folder severity merging.
- `uriKey` — normalized URI string keys for Maps.
- `trendTracker` — periodic snapshots of total problem counts.

---

## Data Flow

### Live Data Flow (Phase 4 — ProblemStore is source of truth, Cache is legacy sync)

```
1. User types / file saves
         |
2. VS Code fires onDidChangeDiagnostics(uris)
         |
3. VSDiagnosticsProvider.onDiagnosticsChanged(uris) — IProblemProvider
         |
4. For each changed URI:
   -> delegate.getUriDiagnostics(uri) returns Diagnostic[]
   -> applySeverityOverrides(uri, diagnostics, severityOverrides)
   -> toProblemState(diagnostics) returns ProblemState
         |
5. Write to ProblemStore.set(uri, state)  ← single source of truth
   Write to ProblemCache.set(uri, state, folderUri)  ← legacy sync
         |
6. Folder propagation:
   -> FolderStatusManager reads snapshot from ProblemStore
   -> aggregateStatuses() computes folder aggregates
   -> Writes aggregates to ProblemStore and ProblemCache
         |
7. Decoration reads from ProblemStore:
   -> onDidChangeFileDecorations.fire(changedUris)
   -> VS Code calls provideFileDecoration(uri) for each visible URI
   -> ProblemStore.get(uri) → badge + color → FileDecoration
   -> Self-healing: if ProblemStore misses, queries live diagnostics and backfills
         |
8. ApiManager reads from ProblemStore:
   -> notifyChanged() emits { uri, status } via ProblemStore.get(uri)
   -> getProblemState(uri) reads from ProblemStore
```

---

## Design Principles

- **Layered architecture** — each layer has one responsibility and depends only on the layer below.
- **Synchronous critical path** — `provideFileDecoration` is synchronous; all hot-path lookups are `O(1)` Map reads.
- **Event-driven updates** — mutations fire events; UI reacts, never polls.
- **Provider-agnostic store** — ProblemStore does not depend on VS Code UI APIs, only on `Uri`.
- **Batch coalescing** — multiple mutations in a batch produce one event, avoiding redundant re-renders.
- **Immutable snapshots** — external consumers receive frozen copies, never internal references.
- **Single canonical `ProblemState`** — one type (`src/core/types.ts`), one `ProblemSeverity` enum, no duplicates.
- **Providers feed the store only** — providers write to `ProblemStore` via `set()`, `delete()`, `clear()`. They never touch `ProblemCache`, decorations, or the status bar. All downstream updates happen reactively through store events.
- **Controllers read from the store** — decoration, status bar, folder propagation, and API controllers subscribe to `ProblemStore.onDidChange` and call `get()` or `snapshot()` to produce their output. They never write to the store.

---

## Current Implementation Status

| Component | Phase | Status |
|---|---|---|
| Extension activation | Phase 0 | Complete |
| ConfigManager | Phase 0 | Complete |
| ProblemCache | Phase 0 | Complete (legacy, write-only in production) |
| DiagnosticsManager | Phase 0 | Complete (active-editor guard, writes only) |
| DecorationEngine | Phase 4 | Complete (reads from ProblemStore) |
| FolderStatusManager | Phase 4 | Complete (reads from ProblemStore) |
| ApiManager | Phase 4 | Complete (reads from ProblemStore) |
| WorkspaceManager | Phase 0 | Complete |
| BadgeFormatter | Phase 0 | Complete |
| ColorProvider | Phase 0 | Complete |
| SeverityMapper | Phase 0 | Complete |
| PropagationStrategy | Phase 0 | Complete |
| IgnoreFilter | Phase 0 | Complete |
| TrendTracker | Phase 0 | Complete |
| **ProblemStore** | **Phase 1** | **Complete (single source of truth, wired)** |
| **IProblemProvider** | **Phase 2** | **Complete** |
| **BaseProblemProvider** | **Phase 2** | **Complete** |
| **ProviderManager** | **Phase 2** | **Complete** |
| **VSDiagnosticsProvider** | **Phase 3** | **Complete (active, writes to ProblemStore)** |

### Future Providers (not yet implemented)

| Provider | Source | Status |
|---|---|---|
| Workspace Scanner | `workspace.onDidChangeWorkspaceFolders` | Not started |
| ESLint | ESLint output channel / API | Not started |
| Python | Python extension API | Not started |
| C++ | C++ extension API | Not started |

---

## Version History

| Tag | Description |
|---|---|---|
| `v0.4.1` | Pre-MVC snapshot. All Phase 0 components complete. |
| `v0.5.0-alpha.1` | Phase 1 complete. ProblemStore built with models, events, batches, versioning, snapshots. |
| `v0.5.0-alpha.2` | Phase 2 complete. Provider layer: IProblemProvider, BaseProblemProvider, ProviderManager. |
| `v0.5.0-alpha.3` | Phase 3 complete. VSDiagnosticsProvider active. ProblemStore wired as single source of truth. |
| `architecture-v2-phase4` | Phase 4 complete. All remaining cache reads migrated to ProblemStore. ProblemCache is legacy write-only sink. |
