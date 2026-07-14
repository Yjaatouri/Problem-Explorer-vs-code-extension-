# Problem Explorer — Architecture

## Overview

Problem Explorer overlays diagnostic information (errors, warnings, info) directly onto files and folders in the VS Code Explorer view using the `FileDecorationProvider` API. It reads diagnostics from `languages.getDiagnostics()`, aggregates them into a normalized cache, and renders badges/colors through file decorations.

---

## Architecture Diagram

```
  Source Layer (Phase 3+)
  ┌───────────────────────────────────────────────┐
  │  VS Diagnostics   ESLint   Python   C++   ...  │
  │  Workspace Scanner  (one provider per source)  │
  └───────────────────────┬───────────────────────┘
                          │
                          v
  Provider Layer (Phase 2)
  ┌───────────────────────────────────────────────┐
  │  IProblemProvider (interface)                  │
  │  BaseProblemProvider (base class)              │
  │  CacheProblemProvider (wraps ProblemCache)     │
  │  StoreProblemProvider (wraps ProblemStore)     │
  │  ProviderManager (register/start/stop/refresh) │
  └───────────────────────┬───────────────────────┘
                          │
                          v
  Store Layer (Phase 1)
  ┌───────────────────────────────────────────────┐
  │  ProblemStore  ───  Map<uri, ProblemState>     │
  │  Events: added/updated/removed/cleared/batch   │
  └───────────────────────┬───────────────────────┘
                          │
                          v
  Controller Layer (Phase 3+)
  ┌───────────────────────────────────────────────┐
  │  DecorationController  StatusBarController    │
  │  FolderPropagationController  ApiController   │
  └───────────────────────┬───────────────────────┘
                          │
                          v
  Current Code (Phase 0 — direct path, not yet migrated)
  ┌───────────────────────────────────────────────┐
  │  DiagnosticsManager → ProblemCache            │
  │  FolderStatusManager → ProblemCache           │
  │  DecorationEngine → ProblemCache              │
  │  ApiManager → ProblemCache                    │
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
- Writes results into `ProblemCache`.
- Guards against transient zero-diagnostic clears (active-editor check).

### ProblemCache (`src/cache/cacheLayer.ts`)
- Two-level `Map<folderKey, Map<uriKey, ProblemState>>`.
- Stores file-level and synthetic folder-aggregate entries.
- Supports `set`, `get`, `delete`, `clear`, `getEntries`, `computeTotals`.
- LRU eviction for large workspaces.

### FolderStatusManager (`src/folder/folderStatusManager.ts`)
- Builds a virtual folder tree from file URIs.
- Propagates worst child severity up to parent folders using `aggregateStatuses()`.
- Creates folder-aggregate entries in the cache.

### DecorationEngine (`src/decoration/decorationEngine.ts`)
- Implements `FileDecorationProvider.provideFileDecoration`.
- Reads from `ProblemCache` for synchronous URI-to-decoration lookup.
- Fires `onDidChangeFileDecorations` to invalidate decorations on change.
- Formats tooltip text ("3 errors, 5 warnings across 12 files").

### WorkspaceManager (`src/workspace/workspaceManager.ts`)
- Tracks `workspace.workspaceFolders` changes.
- Triggers rescans when folders are added or removed.

### ApiManager (`src/api/problemExplorerApi.ts`)
- Exposes the public API surface for other extensions: `getProblemState(uri)`, `onDidChangeProblemState`.
- Bridges between internal cache and external consumers.

### ProblemStore (`src/store/ProblemStore.ts`) — Phase 1
- Synchronous in-memory database: `Map<string, ProblemState>`.
- Discriminated-union events (`added`, `updated`, `removed`, `cleared`, `batch`).
- Batch mutations via `beginBatch()` / `endBatch()`.
- Monotonic version counter (`getVersion()`).
- Frozen `snapshot()` for read-only external access.
- **Not yet wired** into the active extension — currently the future core.

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

**Future providers (all feed ProblemStore, never decorations):**

| Provider | Source | Description |
|---|---|---|
| VS Diagnostics | `languages.onDidChangeDiagnostics` | Maps VS Code diagnostic events into ProblemState (migration of current DiagnosticsManager logic). |
| Workspace Scanner | `workspace.onDidChangeWorkspaceFolders` | Scans workspace structure to seed folder aggregates. |
| ESLint | ESLint output channel / API | Reads ESLint diagnostics (already published as VS Code diagnostics, but may need custom mapping). |
| Python | Python extension API | Reads Pylint / mypy / Pyright diagnostics routed through the store. |
| C++ | C++ extension API | Reads clang-tidy / MSVC diagnostics from the C++ extension. |

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

### Current (Phase 0 — direct cache path)

```
1. User types / file saves
         |
2. VS Code fires onDidChangeDiagnostics(uris)
         |
3. DiagnosticsManager.updateUri(uri) called for each changed URI
         |
4. -> delegate.getUriDiagnostics(uri) returns Diagnostic[]
   -> toProblemState(diagnostics) returns ProblemState
         |
5. Single-file path:
   -> cache.set(uri, state, folderUri) stores file entry
   -> cache.delete(uri, folderUri) if diagnostics empty (active-editor guard)
         |
6. Folder propagation:
   -> FolderStatusManager recomputes folder aggregates
   -> cache.setFolderAggregate(folderUri, aggregate, workspaceFolderUri)
         |
7. DecorationEngine reacts via cache events:
   -> onDidChangeFileDecorations.fire(changedUris)
   -> VS Code calls provideFileDecoration(uri) for each visible URI
   -> Cache lookup → badge + color → FileDecoration
         |
8. Badge formatter:
   -> getBadge(severity, counts, style) → string badge
   -> formatTooltip(state) → string tooltip
```

### Target (Phase 3+ — provider → store → controller)

```
1. Source fires (VS Code diagnostics, ESLint, file watcher, etc.)
         |
2. Corresponding Provider ingests the data
         |
3. Provider writes to ProblemStore.set(uri, state) / .delete(uri)
         |
4. ProblemStore fires onDidChange({ kind: 'added' | 'updated' | 'removed' })
         |
5. Controllers react:
   -> DecorationController: queues decoration invalidation
   -> StatusBarController: recomputes totals
   -> FolderPropagationController: recomputes folder aggregates
   -> ApiController: forwards to external API subscribers
         |
6. VS Code calls provideFileDecoration(uri) → DecorationEngine reads from ProblemStore
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
| ProblemCache | Phase 0 | Complete |
| DiagnosticsManager | Phase 0 | Complete (with active-editor guard) |
| DecorationEngine | Phase 0 | Complete |
| FolderStatusManager | Phase 0 | Complete |
| WorkspaceManager | Phase 0 | Complete |
| ApiManager | Phase 0 | Complete |
| BadgeFormatter | Phase 0 | Complete |
| ColorProvider | Phase 0 | Complete |
| SeverityMapper | Phase 0 | Complete |
| PropagationStrategy | Phase 0 | Complete |
| IgnoreFilter | Phase 0 | Complete |
| TrendTracker | Phase 0 | Complete |
| **ProblemStore** | **Phase 1** | **Complete (not yet wired)** |
| **IProblemProvider** | **Phase 2** | **Complete** |
| **BaseProblemProvider** | **Phase 2** | **Complete** |
| **ProviderManager** | **Phase 2** | **Complete** |
| **VS Diagnostics Provider** | **Phase 3** | **Not started** |
| **Workspace Scanner Provider** | **Phase 3** | **Not started** |
| **Controllers** | **Phase 3** | **Not started** |

---

## Version History

| Tag | Description |
|---|---|
| `v0.4.1` | Pre-MVC snapshot. All Phase 0 components complete. |
| `v0.5.0-alpha.1` | Phase 1 complete. ProblemStore built with models, events, batches, versioning, snapshots. Not yet wired into extension. |
| `architecture-v2-phase2` | Phase 2 in progress. Provider layer: IProblemProvider, BaseProblemProvider, CacheProblemProvider, StoreProblemProvider, ProviderManager. |
