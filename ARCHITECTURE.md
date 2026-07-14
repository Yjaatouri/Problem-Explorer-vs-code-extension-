# Problem Explorer — Architecture

## Overview

Problem Explorer overlays diagnostic information (errors, warnings, info) directly onto files and folders in the VS Code Explorer view using the `FileDecorationProvider` API. It reads diagnostics from `languages.getDiagnostics()`, aggregates them into a normalized cache, and renders badges/colors through file decorations.

---

## Architecture Diagram

```
  VS Code Language API
         |
  DiagnosticsManager ─── reads raw diagnostics, maps to ProblemState
         |
  ProblemCache ───────── two-level Map<folder, Map<uri, ProblemState>>
         |
  +-------|--------+
  |                |
  v                v
FolderStatus   DecorationEngine
Manager             |
  |                 v
  |           FileDecorationProvider (registerFileDecorationProvider)
  |
  +---> ProblemStore (Phase 1, not yet wired)
            |
            v
        onDidChange event
            |
       Providers / Controllers (Phase 2)
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

---

## Design Principles

- **Layered architecture** — each layer has one responsibility and depends only on the layer below.
- **Synchronous critical path** — `provideFileDecoration` is synchronous; all hot-path lookups are `O(1)` Map reads.
- **Event-driven updates** — mutations fire events; UI reacts, never polls.
- **Provider-agnostic store** — ProblemStore does not depend on VS Code UI APIs, only on `Uri`.
- **Batch coalescing** — multiple mutations in a batch produce one event, avoiding redundant re-renders.
- **Immutable snapshots** — external consumers receive frozen copies, never internal references.
- **Single canonical `ProblemState`** — one type (`src/core/types.ts`), one `ProblemSeverity` enum, no duplicates.

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
| **Providers** | **Phase 2** | **Not started** |
| **Controllers** | **Phase 2** | **Not started** |

---

## Version History

| Tag | Description |
|---|---|
| `v0.4.1` | Pre-MVC snapshot. All Phase 0 components complete. |
| `v0.5.0-alpha.1` | Phase 1 complete. ProblemStore built with models, events, batches, versioning, snapshots. Not yet wired into extension. |
