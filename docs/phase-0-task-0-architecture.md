# Problem Explorer — Phase 0, Task 0: Project Discovery & Architecture

> **Author:** Senior VS Code Extension Architect  
> **Project:** Problem Explorer — VS Code Extension  
> **Status:** Complete  
> **Date:** 2026-07-10

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Feature Analysis](#2-feature-analysis)
3. [Technical Feasibility](#3-technical-feasibility)
4. [API Research](#4-api-research)
5. [Architecture](#5-architecture)
6. [Folder Structure](#6-folder-structure)
7. [Data Flow](#7-data-flow)
8. [Data Structures](#8-data-structures)
9. [Performance Strategy](#9-performance-strategy)
10. [Risk Analysis](#10-risk-analysis)
11. [Best Practices](#11-best-practices)
12. [Coding Standards](#12-coding-standards)
13. [Future Scalability](#13-future-scalability)
14. [Recommendations](#14-recommendations)
15. [Final Conclusions](#15-final-conclusions)

---

## 1. Executive Summary

Problem Explorer is a VS Code extension that overlays diagnostic information (errors, warnings) directly onto files and folders in the Explorer view. Instead of forcing developers to open the Problems panel, the Explorer itself becomes a real-time visual map of project health.

The project is at **Phase 0** — a greenfield state. The repository contains only a README. This document performs full project discovery by researching the VS Code Extension API, designing a clean modular architecture, selecting optimal data structures, and defining a performance strategy for workspaces with 20,000+ files.

**Key architectural decisions:**

- Use `FileDecorationProvider` API as the sole rendering mechanism (no custom tree views)
- Use `languages.onDidChangeDiagnostics` to react to diagnostic changes in real time
- Implement a `DiagnosticsManager` that normalizes the flat API response into a structured tree
- Use a two-level `Map<WorkspaceFolder, Map<Uri, ProblemStatus>>` as the core cache
- Employ debounced batch updates and an LRU eviction strategy for large workspaces
- Adopt a strict layered architecture: Extension Core → Diagnostics Manager → Decoration Engine → Cache Layer

---

## 2. Feature Analysis

### 2.1 Required Features

| Feature | Priority | Description |
|---|---|---|
| File error decoration | P0 | Show a red badge/color on files with errors |
| File warning decoration | P0 | Show a yellow badge/color on files with warnings |
| Folder propagation | P0 | Folders inherit the worst severity of their children |
| Real-time updates | P0 | Decorations update as diagnostics change |
| Language agnostic | P0 | Works with any language that publishes diagnostics |
| Configurable colors | P1 | User-configurable ThemeColor via settings |
| Configurable behavior | P1 | Show/hide warnings, toggle on/off per workspace |
| Performance for 20k+ files | P1 | Must not degrade Explorer performance |
| Multi-root workspace | P1 | Support multiple workspace folders |
| Ignore folders | P2 | Exclude node_modules, dist, build, etc. |
| Refresh command | P2 | Manual `problemExplorer.refresh` command |
| Badge counts | P2 | Show "3 errors, 5 warnings" in tooltip |

### 2.2 Feature-API Mapping

| Feature | VS Code API | Mechanism |
|---|---|---|
| File decorations | `FileDecorationProvider.provideFileDecoration` | Returns `FileDecoration` with badge/color per file URI |
| Folder decorations | `FileDecorationProvider.provideFileDecoration` | Same API; VS Code calls it for folder URIs too |
| Real-time updates | `FileDecorationProvider.onDidChangeFileDecorations` | Fire event with changed URIs to invalidate decorations |
| Diagnostic listening | `languages.onDidChangeDiagnostics` | Subscribe to global diagnostic change events |
| Reading diagnostics | `languages.getDiagnostics(uri)` or `languages.getDiagnostics()` | Query per-file or full snapshot |
| Configurable colors | `workspace.getConfiguration('problemExplorer')` + `ThemeColor` | Read settings, define custom ThemeColors |
| Multi-root | `workspace.workspaceFolders`, `workspace.onDidChangeWorkspaceFolders` | Track each root independently |

---

## 3. Technical Feasibility

### 3.1 Green Light

The core feature set maps cleanly to stable, non-proposed VS Code APIs:

- `window.registerFileDecorationProvider()` — stable since VS Code 1.37
- `languages.onDidChangeDiagnostics` — stable since VS Code 1.9
- `languages.getDiagnostics()` — stable since VS Code 1.9
- `workspace.getConfiguration()` — stable
- `ThemeColor` — stable
- `workspace.workspaceFolders` — stable

No proposed APIs are needed. No dependency on any language extension is required. The extension reads diagnostics only — it never writes to diagnostic collections.

### 3.2 Caution Areas

| Area | Concern | Mitigation |
|---|---|---|
| `provideFileDecoration` called per URI | VS Code may call this for every visible file/folder in Explorer | Use a fast synchronous lookup from a pre-built cache; never do I/O or async work inside this method |
| `onDidChangeFileDecorations` fire frequency | Firing for too many URIs at once could throttle the renderer | Batch changes; fire at most once per animation frame using a debounce |
| `languages.getDiagnostics()` is O(n) for full scan | Full scan across 20k files is expensive | Only call `getDiagnostics(uri)` for changed URIs from the event; maintain an incremental cache |

### 3.3 Feasibility Verdict

**Fully feasible.** The feature set is a textbook use case for `FileDecorationProvider`. The main risk is performance under high diagnostic churn, which is addressable through caching, debouncing, and incremental updates.

---

## 4. API Research

### 4.1 `window.registerFileDecorationProvider`

This is the **central API** for the extension.

```typescript
import * as vscode from 'vscode';

const provider = vscode.window.registerFileDecorationProvider({
  provideFileDecoration(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    // Must be fast. Called on every visible Explorer item.
    const status = cache.get(uri);
    if (!status) return undefined;
    return new vscode.FileDecoration(
      status.badge,         // string like "E" or "W"
      status.tooltip,       // "2 errors, 3 warnings"
      status.color           // ThemeColor for error/warning
    );
  },

  onDidChangeFileDecorations?: vscode.Event<vscode.Uri | vscode.Uri[]>;
    // Fire this when diagnostics change to invalidate decorations
});
```

**Critical behavioral detail from the API docs** (vscode.d.ts):

> *"Note that this function is only called when a file gets rendered in the UI. This means a decoration from a descendent that propagates upwards must be signaled to the editor via the onDidChangeFileDecorations event."*

This means: when a child file's decoration changes, we must explicitly fire `onDidChangeFileDecorations` with the parent folder's URI. VS Code will not automatically re-query the parent. This is the single most important implementation detail for folder propagation.

### 4.2 `FileDecoration`

Constructor and properties:

```typescript
new FileDecoration(badge?: string, tooltip?: string, color?: ThemeColor)

// Properties
FileDecoration.badge: string | undefined     // 1-2 character badge (e.g., "E", "W", "!")
FileDecoration.tooltip: string | undefined   // Hover text
FileDecoration.color: ThemeColor | undefined  // From ThemeColor or custom color id
FileDecoration.propagate: boolean            // Defaults to true; controls badge propagation
```

**Key insight:** The `propagate` property (default `true`) controls whether the *badge* propagates to parent items. However, it does **not** affect the *color* or *tooltip*. Folder color propagation must be done manually by firing `onDidChangeFileDecorations` with folder URIs.

### 4.3 `ThemeColor`

```typescript
new ThemeColor('problemExplorer.errorForeground');
```

ThemeColors can reference:
1. Built-in theme colors (e.g., `errorForeground`, `list.errorForeground`)
2. Custom colors contributed via `contributes.colors` in `package.json`

**Recommendation:** Contribute two custom colors — `problemExplorer.errorForeground` and `problemExplorer.warningForeground` — with sensible defaults that reference built-in colors. This allows users to customize via `workbench.colorCustomizations`.

### 4.4 `languages.getDiagnostics()`

Two overloads:

```typescript
// Full snapshot — returns all diagnostics for all resources
languages.getDiagnostics(): [Uri, Diagnostic[]][];

// Per-resource — returns diagnostics for a specific file
languages.getDiagnostics(uri: Uri): Diagnostic[];
```

**Performance guidance:** Never call the no-argument overload on a timer. Only use it on initial activation to seed the cache. For ongoing updates, rely on `onDidChangeDiagnostics` events which provide the URIs that changed.

### 4.5 `DiagnosticCollection`

```typescript
interface DiagnosticCollection {
  readonly name: string;
  set(uri: Uri, diagnostics: Diagnostic[] | undefined): void;
  delete(uri: Uri): void;
  clear(): void;
  forEach(callback: (uri: Uri, diagnostics: readonly Diagnostic[], collection: DiagnosticCollection) => any, thisArg?: any): void;
  dispose(): void;
}
```

**Note:** Problem Explorer only *reads* diagnostics — it never creates or owns a `DiagnosticCollection`. Other extensions (TypeScript, ESLint, etc.) publish to their own collections. We consume them via `languages.getDiagnostics()`.

### 4.6 `DiagnosticChangeEvent`

```typescript
interface DiagnosticChangeEvent {
  readonly uris: readonly Uri[];
}
```

Fired when any diagnostic collection changes. The `uris` array contains only the URIs whose diagnostics changed. Use this for incremental updates.

**Important:** This event fires frequently during typing. Every keystroke in a TypeScript file triggers at least one diagnostic re-evaluation. Debouncing is essential.

### 4.7 `WorkspaceFolder`

```typescript
interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}
```

Available via `workspace.workspaceFolders` (which may be `undefined` if no folder is open). Changes detected via `workspace.onDidChangeWorkspaceFolders`.

### 4.8 `workspace.getConfiguration()`

```typescript
const config = workspace.getConfiguration('problemExplorer');
config.get<boolean>('showWarnings', true);
config.get<string>('errorColor', 'problemExplorer.errorForeground');
```

### 4.9 `commands`

```typescript
// Registering a command
context.subscriptions.push(
  commands.registerCommand('problemExplorer.refresh', () => {
    decorationEngine.refresh();
  })
);
```

### 4.10 Activation Events

Three activation events are relevant:

```typescript
// package.json
{
  "activationEvents": [
    "onStartupFinished",
    "onCommand:problemExplorer.refresh"
  ]
}
```

**Recommendation:** Use `onStartupFinished` rather than `*` to avoid slowing down VS Code startup. The extension can safely activate after all core services are ready. We also add an `onCommand` for the manual refresh command. Do **not** use `onLanguage:*` since we are language-agnostic.

### 4.11 Extension Lifecycle

```typescript
export function activate(context: vscode.ExtensionContext): void {
  // 1. Initialize modules
  const configManager = new ConfigManager();
  const diagnosticsManager = new DiagnosticsManager();
  const cache = new CacheLayer();
  const decorationProvider = new DecorationEngine(cache, configManager);
  const folderManager = new FolderStatusManager(cache, diagnosticsManager);

  // 2. Register provider
  context.subscriptions.push(
    window.registerFileDecorationProvider(decorationProvider)
  );

  // 3. Subscribe to diagnostics changes
  context.subscriptions.push(
    languages.onDidChangeDiagnostics(e => {
      diagnosticsManager.handleDiagnosticChange(e);
    })
  );

  // 4. Subscribe to config changes
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('problemExplorer')) {
        configManager.refresh();
        decorationProvider.refresh();
      }
    })
  );

  // 5. Register commands
  context.subscriptions.push(
    commands.registerCommand('problemExplorer.refresh', () => {
      diagnosticsManager.fullScan();
      decorationProvider.refresh();
    })
  );

  // 6. Initial scan
  diagnosticsManager.fullScan();
}

export function deactivate(): void {
  // All disposables in context.subscriptions are cleaned up automatically
  // No additional cleanup needed
}
```

### 4.12 Explorer Decorations — How VS Code Renders Them

When `FileDecorationProvider.provideFileDecoration` returns a `FileDecoration`:

- The `badge` (1-2 chars) appears to the right of the file/folder name
- The `color` tints the badge text
- The `tooltip` appears on hover
- VS Code does **not** modify the file icon itself — only adds badge text/color

**Visual behavior:**
- A file with errors: `parser.ts` → `parser.ts E` (in red)
- A file with warnings: `lexer.ts` → `lexer.ts W` (in yellow)
- A folder with errors: `core` → `core E` (in red)

This is less intrusive than icon overlays (like Source Control) and works with any file icon theme.

---

## 5. Architecture

### 5.1 Module Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Extension Core (activate/deactivate)        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    DiagnosticsManager                      │  │
│  │  - Subscribes to onDidChangeDiagnostics                   │  │
│  │  - Calls languages.getDiagnostics()                       │  │
│  │  - Normalizes data into ProblemStatus                     │  │
│  │  - Publishes change events                                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    CacheLayer                              │  │
│  │  - Map<WorkspaceFolder, Map<Uri, ProblemStatus>>          │  │
│  │  - Folder status computed from children                   │  │
│  │  - LRU eviction for unseen files                          │  │
│  │  - O(1) lookups for provideFileDecoration                 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   DecorationEngine                         │  │
│  │  - Implements FileDecorationProvider                      │  │
│  │  - provideFileDecoration: cache lookup + ThemeColor       │  │
│  │  - onDidChangeFileDecorations: batch fire event           │  │
│  │  - Manages debounced update scheduling                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                 FolderStatusManager                        │  │
│  │  - Computes aggregate folder status from children         │  │
│  │  - Handles nested folder propagation                      │  │
│  │  - Identifies affected ancestors on change                │  │
│  │  - Publishes affected URI list for re-render              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                ConfigurationManager                       │  │
│  │  - Reads problemExplorer.* settings                       │  │
│  │  - Exposes observable config state                        │  │
│  │  - Triggers re-render on config change                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   CommandManager                           │  │
│  │  - Registers problemExplorer.refresh                      │  │
│  │  - Registers problemExplorer.toggle                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  PerformanceLayer                          │  │
│  │  - Debounce/throttle diagnostics events                   │  │
│  │  - Batch URI collection for re-render                      │  │
│  │  - Ignored paths filter                                    │  │
│  │  - LRU cache eviction                                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Module Responsibilities

#### 5.2.1 Extension Core (`extension.ts`)
- Single entry point exported as `activate`/`deactivate`
- Creates all manager instances, wires dependencies, registers disposables
- Handles lifecycle: initialization order, graceful shutdown
- Does **not** contain business logic

#### 5.2.2 DiagnosticsManager (`diagnosticsManager.ts`)
- Subscribes to `languages.onDidChangeDiagnostics`
- On change: reads diagnostics for each affected URI via `languages.getDiagnostics(uri)`
- Converts `Diagnostic[]` to `ProblemStatus` (severity level per file)
- Publishes internal event `onDiagnosticsChanged(affectedUris: Uri[])`
- On initial scan: calls `languages.getDiagnostics()` then seeds the cache

#### 5.2.3 CacheLayer (`cache.ts`)
- Primary data store. Two-level map structure.
- File entries: `Map<WorkspaceFolder, Map<Uri, FileProblemStatus>>`
- Folder entries computed on-demand by `FolderStatusManager`
- Provides `get(uri): ProblemStatus | undefined` in O(1)
- Provides `set(uri, status)` and `delete(uri)`
- Exposes `getAllUrisInWorkspace(): Uri[]` for iteration
- LRU wrapper around the per-folder maps to cap memory
- Tracks ignored paths; filters them during insertion

#### 5.2.4 DecorationEngine (`decorationEngine.ts`)
- Implements `FileDecorationProvider` interface
- `provideFileDecoration(uri)`: synchronous lookup in cache, returns `FileDecoration` or `undefined`
- `onDidChangeFileDecorations`: `EventEmitter<Uri | Uri[]>`, fires for dirty URIs
- `refresh()`: fires `onDidChangeFileDecorations` with `undefined` (or all workspace URIs) to trigger full re-render
- Converts `ProblemStatus` to visual representation using current config
- Creates `ThemeColor` from configurable color IDs

#### 5.2.5 FolderStatusManager (`folderStatusManager.ts`)
- Computes folder status by aggregating all descendant file statuses
- Strategy: walk up from changed file to root, mark each ancestor as dirty
- On file change: `[file.ts] → [parentDir, grandparentDir, ..., root]`
- Publishes set of changed folder URIs for re-render
- Uses worst-severity-wins rule: errors > warnings > info > clean

#### 5.2.6 ConfigurationManager (`configManager.ts`)
- Reads all `problemExplorer.*` settings from VS Code configuration
- Exposes reactive state: current colors, enabled/disabled, ignored paths, badge style
- Listens to `workspace.onDidChangeConfiguration` with `e.affectsConfiguration('problemExplorer')`
- Invalidates cache and triggers re-render when relevant settings change

#### 5.2.7 CommandManager (`commandManager.ts`)
- Registers and provides handlers for extension commands
- `problemExplorer.refresh` → forces a full diagnostic scan + decoration refresh
- `problemExplorer.toggle` → toggles decoration visibility
- Can be extended for future commands (`enableWarnings`, `configure`, etc.)

#### 5.2.8 PerformanceLayer (`performance.ts`)
- Utilities, not a class:
  - `debounce(fn, ms)` — for `onDidChangeDiagnostics` events
  - `batchUris(uris: Uri[]): Uri[][]` — splits large URI arrays
  - `isIgnoredPath(uri, patterns): boolean` — glob matching against ignore list
  - `lruCache<K, V>(maxSize)` — LRU map wrapper
- All modules use these utilities; no module calls the raw API without going through PerformanceLayer guards

### 5.3 Module Communication

- **No circular dependencies.** Dependencies flow downward: Core → Managers → Utils
- **Event-based.** Modules communicate through VS Code events (`EventEmitter<T>`) or through the cache
- **DiagnosticsManager → CacheLayer:** direct write
- **FolderStatusManager → CacheLayer:** direct write (folder entries)
- **DecorationEngine → CacheLayer:** direct read
- **FolderStatusManager → DecorationEngine:** via shared `onDidChangeFileDecorations` event emitter
- **ConfigManager → all:** modules query config directly via `workspace.getConfiguration()` (no separate event bus needed)

---

## 6. Folder Structure

```
problem-explorer/
├── .vscode/
│   ├── launch.json              # F5 debug config
│   ├── tasks.json               # Build task
│   └── settings.json            # Workspace settings
│
├── src/
│   ├── extension.ts             # Entry point: activate / deactivate
│   ├── extensionState.ts        # Alias for lazy activation (future DI)
│   │
│   ├── core/                    # Framework-agnostic core logic
│   │   ├── types.ts             # All shared types/interfaces/enums
│   │   ├── constants.ts         # Enums, const values, magic strings
│   │   └── errors.ts            # Custom error classes
│   │
│   ├── diagnostics/             # Diagnostic management
│   │   ├── diagnosticsManager.ts
│   │   └── severityMapper.ts    # Maps DiagnosticSeverity → ProblemSeverity
│   │
│   ├── decoration/              # File decoration + provider
│   │   ├── decorationEngine.ts  # FileDecorationProvider implementation
│   │   ├── badgeFormatter.ts    # Badge text generation ("E", "W", "!")
│   │   └── colorProvider.ts     # ThemeColor resolution
│   │
│   ├── folder/                  # Folder propagation logic
│   │   ├── folderStatusManager.ts
│   │   ├── folderTree.ts        # URI-based tree for ancestor walk
│   │   └── propagationStrategy.ts  # Severity aggregation rules
│   │
│   ├── cache/                   # Data storage
│   │   ├── cacheLayer.ts        # Primary cache (Map-of-Maps)
│   │   └── lruCache.ts          # LRU eviction wrapper
│   │
│   ├── config/                  # Configuration management
│   │   ├── configManager.ts     # Reads settings, exposes config
│   │   ├── defaults.ts          # Default configuration values
│   │   └── schema.ts            # TypeScript types matching config schema
│   │
│   ├── commands/                # Command registration
│   │   ├── commandManager.ts    # Registers all commands
│   │   ├── refresh.ts           # Refresh handler
│   │   └── toggle.ts            # Toggle handler
│   │
│   ├── performance/             # Performance utilities
│   │   ├── debounce.ts          # Event debouncing
│   │   ├── batch.ts             # Batch processing
│   │   ├── ignoreFilter.ts      # Glob-based path ignore
│   │   └── throttle.ts          # Throttle for rapid events
│   │
│   ├── workspace/               # Workspace awareness
│   │   ├── workspaceManager.ts  # Multi-root tracking
│   │   └── uriUtils.ts          # URI comparison, path extraction
│   │
│   └── test/                    # Tests (mirrors src structure)
│       ├── suite/
│       │   ├── diagnosticsManager.test.ts
│       │   ├── cacheLayer.test.ts
│       │   ├── folderStatusManager.test.ts
│       │   └── decorationEngine.test.ts
│       └── runTest.ts           # Test runner entry
│
├── test-resources/              # Fixtures for integration tests
│   └── sample-workspace/        # Sample project with known diagnostics
│
├── package.json                 # Extension manifest
├── tsconfig.json                # TypeScript config
├── .eslintrc.json               # Linter config
├── .vscodeignore                # Files excluded from .vsix
├── README.md                    # Project README
├── CHANGELOG.md                 # Version changelog
├── LICENSE                      # MIT license
└── webpack.config.js            # Bundler config (for production)
```

### 6.1 Why Each Folder Exists

| Folder | Purpose |
|---|---|
| `src/core/` | Pure types, constants, errors — no VS Code API dependency. Can be tested without a VS Code host. |
| `src/diagnostics/` | All diagnostic reading logic. Isolated from rendering concerns. |
| `src/decoration/` | The VS Code integration layer — `FileDecorationProvider` lives here. |
| `src/folder/` | The most complex business logic — folder tree propagation. Separated to keep `decorationEngine.ts` simple. |
| `src/cache/` | Performance-critical data store. Isolating it makes it easy to swap implementations (e.g., Map vs. WeakMap vs. external store). |
| `src/config/` | Configuration parsing. The `schema.ts` type file ensures type safety between `package.json` config and code. |
| `src/commands/` | Command handlers. Each command in its own file for testability. |
| `src/performance/` | Utility functions that every module imports. Centralizing them avoids scattered debounce/throttle logic. |
| `src/workspace/` | Multi-root workspace awareness. Encapsulates `.workspaceFolders` access. |
| `src/test/` | Integration and unit tests. Mirrors `src/` structure so tests are easy to locate. |

### 6.2 Why NOT a Monolithic Structure

Avoiding a flat `src/` directory with 15+ files prevents:

- Circular dependencies (easier to detect with clear module boundaries)
- Low testability (each module is independently testable)
- Cognitive load when reading (you can navigate by concern)
- Merge conflicts in large files

---

## 7. Data Flow

### 7.1 Initial Activation Flow

```
activate()
  └─ ConfigManager.init()
  └─ DiagnosticsManager.init()
       └─ languages.getDiagnostics()         // Get all diagnostics
       └─ for each [uri, diagnostics]:
            └─ severityMapper.toStatus()       // Diagnostic[] → ProblemStatus
            └─ CacheLayer.set(uri, status)     // Store in cache
       └─ FolderStatusManager.rebuildAll()    // Compute folder statuses
            └─ CacheLayer.set(folderUri, folderStatus) for each folder
  └─ DecorationEngine.register()              // window.registerFileDecorationProvider(this)
  └─ CommandManager.register()
  └─ Subscribe to:
       └─ languages.onDidChangeDiagnostics
       └─ workspace.onDidChangeConfiguration
       └─ workspace.onDidChangeWorkspaceFolders
```

### 7.2 Runtime Diagnostic Change Flow

```
User types → Language server re-evaluates
  └─ languages.onDidChangeDiagnostics fires
  └─ DiagnosticChangeEvent.uris → ["file:///project/src/parser.ts"]
  └─ DiagnosticsManager.handleDiagnosticChange(event)
       └─ For each uri in event.uris:
            └─ diagnostics = languages.getDiagnostics(uri)
            └─ newStatus = severityMapper.toStatus(diagnostics)
            └─ changed = CacheLayer.set(uri, newStatus)
            └─ if changed || newStatus !== oldStatus:
                 └─ dirtyUris.add(uri)
                 └─ FolderStatusManager.updateAncestors(uri)
                      └─ Walk URI → parent → grandparent → ... → workspace root
                      └─ For each ancestor:
                           └─ Recompute folder status from children
                           └─ If status changed: dirtyUris.add(ancestor)
  └─ PerformanceLayer.batchAndDebounce(dirtyUris, () => {
       └─ DecorationEngine.fireDidChange(dirtyUris)
       └─ VS Code re-calls provideFileDecoration for each dirty URI
       └─ DecorationEngine reads from cache (O(1))
       └─ Returns FileDecoration or undefined
       └─ Explorer re-renders
  })
```

### 7.3 Folder Expansion Flow

```
User clicks on a collapsed folder in Explorer
  └─ VS Code calls provideFileDecoration for each visible child file
  └─ Each call is a synchronous cache lookup → no performance issue
  └─ If the folder was previously collapsed:
       └─ Its status was already pre-computed and cached
       └─ No additional work needed
```

### 7.4 Configuration Change Flow

```
User changes problemExplorer.errorColor in settings
  └─ workspace.onDidChangeConfiguration fires
  └─ ConfigManager detects relevant change
  └─ Calls DecorationEngine.refresh()
       └─ Fires onDidChangeFileDecorations(undefined)
       └─ VS Code re-calls provideFileDecoration for all visible items
       └─ New ThemeColor values are applied
```

### 7.5 Workspace Folder Change Flow

```
User adds/removes a workspace folder
  └─ workspace.onDidChangeWorkspaceFolders fires
  └─ WorkspaceManager.handleChange(event)
       └─ For added folders:
            └─ DiagnosticsManager.fullScan() for new folder URIs only
       └─ For removed folders:
            └─ CacheLayer.clearFolder(folder)
  └─ DecorationEngine.refresh()
```

---

## 8. Data Structures

### 8.1 Problem Severity Levels

```typescript
enum ProblemSeverity {
  None = 0,      // No diagnostics
  Info = 1,      // Informational only
  Warning = 2,   // Warnings present
  Error = 3,     // Errors present
}
```

**Why enum over boolean flags:** A single severity axis is simpler to compare (`max(a, b)`) and matches the propagation logic (worst-severity-wins). Boolean flags would require extra logic to handle the "both errors and warnings" case.

### 8.2 ProblemStatus (Value Object)

```typescript
interface ProblemStatus {
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
}
```

**Why value object:** Immutable. Once computed, it cannot be mutated in place. This prevents cache corruption from accidental mutation and simplifies change detection (reference comparison).

### 8.3 Core Cache: `Map<WorkspaceFolder, Map<string, ProblemStatus>>`

```typescript
// Cache implementation
class ProblemCache {
  private store: Map<string, ProblemStatus>;  // Keyed by URI.toString()

  get(uri: Uri): ProblemStatus | undefined {
    return this.store.get(uri.toString());
  }

  set(uri: Uri, status: ProblemStatus): boolean {
    const key = uri.toString();
    const old = this.store.get(key);
    if (old === status) return false;  // Reference equality: no change
    this.store.set(key, status);
    return true;
  }

  delete(uri: Uri): void {
    this.store.delete(uri.toString());
  }

  // ...iteration methods
}
```

**Why two-level Map-of-Maps?**

| Structure | Rationale |
|---|---|
| `Map<WorkspaceFolder, ...>` | Clean separation per workspace root. When a folder is removed, we clear its entire map. Prevents URI collisions between roots. |
| Inner `Map<string, ProblemStatus>` | O(1) lookup by URI string. `Uri.toString()` is canonical and comparable. |

**Alternative considered:** Single `Map<Uri, ProblemStatus>` with `Uri` as key. Rejected because `Uri` comparison is by reference, and we receive different `Uri` objects from different API calls. Using `Uri.toString()` as string keys guarantees equality.

### 8.4 LRU Cache Wrapper

```typescript
class LruCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;  // JavaScript Map preserves insertion order

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);  // Re-insert to move to end (most recent)
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);  // Evict least recently used
    }
    this.cache.set(key, value);
  }
}
```

**Why use Map insertion order for LRU instead of a linked list?**
- JavaScript `Map` guarantees insertion order iteration
- Re-inserting a key moves it to the end (most recently used)
- Iterating keys yields the LRU item first
- No external library needed
- O(1) operations

### 8.5 Changed URI Set (for event batching)

```typescript
// During a debounce window, collect all URIs that need re-render
const dirtyUris: Set<string> = new Set();

// When debounce fires:
decorationEngine.fireDidChange(Array.from(dirtyUris).map(Uri.parse));
dirtyUris.clear();
```

**Why `Set<string>` instead of `Set<Uri>`:** Multiple `Uri` objects may represent the same resource. A `Set<Uri>` would use reference equality, allowing duplicates. String keys guarantee set semantics.

### 8.6 Folder Ancestor Tree (implicit)

The folder tree is **not stored explicitly** as a tree data structure. Instead:

- Folder URIs are derived from file URIs by removing the last path segment
- Walking up the tree: repeat `uri.with({ path: dirname(uri.path) })` until the workspace root is reached
- This avoids maintaining a separate tree that must stay in sync with the filesystem

**Trade-off:** Walking up via string manipulation is O(depth) per change. For a file at depth 10, we walk 10 levels. This is acceptable because:
1. Directory depth is bounded (typically < 20)
2. We only walk on actual diagnostic changes (not on every Explorer scroll event)
3. String manipulation is cheap

### 8.7 Data Structure Summary

| Structure | Type | Used For | Why Optimal |
|---|---|---|---|
| Core cache | `Map<string, ProblemStatus>` | URI → status lookup | O(1) lookup, O(1) insertion |
| Per-root maps | `Map<string, Map<string, ProblemStatus>>` | Workspace isolation | Clean folder removal, no URI collisions |
| LRU wrapper | `Map<K, V>` with re-insertion | Memory cap | O(1), uses built-in Map ordering |
| Dirty set | `Set<string>` | Change accumulation | Prevents duplicates, O(1) add |
| Severity enum | `enum ProblemSeverity` | Status comparison | Natural ordering (None < Info < Warning < Error) |
| ProblemStatus | `interface` (immutable) | Cached values | Reference equality change detection |
| Event emitter | `EventEmitter<Uri \| Uri[]>` | Module communication | VS Code standard pattern, disposable |

---

## 9. Performance Strategy

### 9.1 Targets

| Metric | Target | Measurement |
|---|---|---|
| `provideFileDecoration` latency | < 1µs | Micro-benchmark |
| Event processing latency | < 5ms per diagnostic change | `performance.now()` |
| Full workspace scan (20k files) | < 200ms | Initial activation timing |
| Memory usage (20k files) | < 10 MB | Process memory snapshot |
| Decorations visible in Explorer | No perceptible delay | Visual inspection |

### 9.2 Techniques

#### 9.2.1 Synchronous provideFileDecoration

`provideFileDecoration` must never:
- Call `languages.getDiagnostics()` (async or sync — too slow)
- Perform I/O
- Do any computation more complex than a cache lookup
- Allocate memory (reuse objects where possible)

**Implementation:** The method is a single `return cache.get(uri)` — nothing else.

#### 9.2.2 Debounced Diagnostic Events

```typescript
const PROCESSING_DEBOUNCE_MS = 50;

const debouncedHandler = debounce((uris: Uri[]) => {
  diagnosticsManager.processChanges(uris);
}, PROCESSING_DEBOUNCE_MS);

languages.onDidChangeDiagnostics(e => {
  debouncedHandler(e.uris);
});
```

**Why 50ms:** Covers a burst of keystroke-induced diagnostics without making the update feel laggy. VS Code's animation frame is ~16ms; 50ms gives 3 frames of buffer. Visual updates through `onDidChangeFileDecorations` fire asynchronously anyway.

#### 9.2.3 Incremental Updates Only

On `onDidChangeDiagnostics`, we process only the URIs listed in the event. We never call `languages.getDiagnostics()` (the no-argument overload) except on initial activation. This reduces per-keystroke work from "scan 20k files" to "evaluate 1-3 changed files."

#### 9.2.4 LRU Cache with Capacity Limit

```typescript
const PER_FOLDER_CACHE_LIMIT = 10000; // 10k entries per workspace folder

// If a folder has 20k files, only the 10k most recently seen are cached
// Files outside the visible viewport are evicted
```

**Eviction strategy:** When the cache is full, the least recently accessed entry (by `provideFileDecoration`) is evicted. This means only visible files remain cached. When a file scrolls into view, its decoration will be `undefined` temporarily until the next diagnostic change event — which is acceptable because:
1. The Explorer will re-query once the file is visible
2. If no diagnostic change happens, the file has no diagnostics anyway (no change from its evicted state)

**Edge case:** If a file with diagnostics scrolls into view but hasn't had a change event, it will briefly show no decoration. Mitigation: on `provideFileDecoration` cache miss, lazily fall back to `languages.getDiagnostics(uri)` (single URI lookup — cheap). This ensures correctness at the cost of a ~0.1ms lookup.

#### 9.2.5 Batch UI Updates

```typescript
// Instead of firing onDidChangeFileDecorations for each URI individually:
const allDirty = collectDirtyUris();
decorationEngine.fireDidChange(allDirty.length === 0 ? undefined : allDirty);

// VS Code handles the batch internally; individual fires cause redundant layout
```

#### 9.2.6 Ignored Paths Filter

```typescript
// Default ignored patterns
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',   // Rust
  '**/__pycache__/**',
];
```

Ignored paths are filtered at two levels:
1. **In DiagnosticsManager:** Never add to cache (avoids cache pollution)
2. **In CacheLayer:** Also filter on read as a safety net

#### 9.2.7 Lazy Folder Status Computation

Folder statuses are computed **only when:**
1. A child file's diagnostic changes (triggered by ancestor walk)
2. On initial scan

Never computed eagerly for all folders in the workspace. A folder with no visible children in the Explorer may never need its status computed.

#### 9.2.8 Efficient Folder Ancestor Walk

```typescript
function updateAncestors(fileUri: Uri): Uri[] {
  const changed: Uri[] = [];
  let current = fileUri.with({ path: dirname(fileUri.path) });

  while (!isWorkspaceRoot(current)) {
    const children = cache.getChildren(current);
    const newStatus = computeAggregateStatus(children);
    const oldStatus = cache.get(current);

    if (newStatus.severity !== oldStatus?.severity || newStatus !== oldStatus) {
      cache.set(current, newStatus);
      changed.push(current);
    }

    current = current.with({ path: dirname(current.path) });
  }

  return changed;
}
```

**Optimization:** Use `uri.with({ path: dirname(path) })` instead of `Uri.joinPath()` — it's faster and avoids object allocation overhead by reusing the base URI.

#### 9.2.9 Deferred Synchronization for Active Editors

When the user is actively editing a file, diagnostics may change on every keystroke. We use `requestAnimationFrame` semantics via `setTimeout(0)` to defer the folder propagation to after the current event loop tick, ensuring the UI remains responsive.

### 9.3 Benchmark Plan

| Scenario | Action | Expected Time |
|---|---|---|
| Cold start, 10k files | `languages.getDiagnostics()` | < 100ms |
| Cold start, 10k files | Cache seeding | < 50ms |
| Cold start, 10k files | Folder status rebuild | < 100ms |
| Single file change | Process, propagate, fire event | < 5ms |
| 100 simultaneous file changes (batch build) | Debounced batch processing | < 50ms |
| Explorer scroll, 100 new files visible | 100x `provideFileDecoration` | < 0.5ms total |
| 10k file cache, random access | LRU get/set | < 1ms |

---

## 10. Risk Analysis

### 10.1 API Limitations

| Risk | Impact | Mitigation |
|---|---|---|
| `FileDecoration` has no background/fill color — only badge text color | Cannot tint file icon background | Accept limitation. Badge text with ThemeColor is visually distinct enough. Consider contributing to VS Code to add background color support in the future. |
| `propagate` only affects badge, not color | Folder colors must be manually propagated | Explicitly fire `onDidChangeFileDecorations` for all ancestor folders when a child changes. |
| `provideFileDecoration` is synchronous | Cannot do async work | Pre-compute everything into cache. Never do async work in the provider. |
| No way to force re-query for ALL items | Must fire event per URI (or pass undefined) | Use `onDidChangeFileDecorations.fire(undefined)` to signal "all items may have changed." VS Code handles the re-query efficiently. |
| Diagnostic events may fire before extension activation | May miss initial diagnostics from other extensions | Always do a full scan in `activate()` to catch up. |

### 10.2 Performance Bottlenecks

| Bottleneck | Cause | Mitigation |
|---|---|---|
| Full `languages.getDiagnostics()` | O(n) over all files in workspace | Call only once on activation. Use incremental URIs from events thereafter. |
| Folder propagation on large flat directories | Walking 1000+ children to compute aggregate | Use `getAllUrisInWorkspace()` only when absolutely necessary. For deep trees, the walk is bounded by depth. |
| Frequent diagnostic events | Every keystroke in TypeScript/Python | Debounce 50ms. Process in batches. |
| Memory for 20k file entries | ~400 bytes per entry → ~8 MB | LRU cache with 10k limit. Use string keys (shared via interning). |

### 10.3 Memory Issues

| Issue | Detail | Mitigation |
|---|---|---|
| URI.toString() allocations | Each URI toString creates a new string | Cache the string key alongside the status. Reuse when possible. |
| ProblemStatus object per file | 20k files = 20k small objects | Use LRU eviction. Object pooling if memory becomes problematic. |
| Diagnostic array retention | Holding references to large Diagnostic arrays | Extract only severity counts, discard the `Diagnostic` objects immediately after processing. |
| Folder intermediate status objects | One per folder in workspace | Compute on-demand via FolderStatusManager rather than storing all eagerly. |

### 10.4 Edge Cases

| Edge Case | Behavior | Handling |
|---|---|---|
| No workspace folder open | `workspace.workspaceFolders` is undefined | Gracefully degrade — no decorations to show. Listen for `onDidChangeWorkspaceFolders` to activate when a folder is added. |
| File deleted from disk but diagnostics remain | Stale cache entry | Listen to `workspace.onDidDeleteFiles` or use `workspace.createFileSystemWatcher` to evict deleted files from cache. |
| Extremely long file paths (>260 chars on Windows) | `uri.toString()` may cause issues | Use `uri.fsPath` for path operations on Windows. |
| Unicode/non-ASCII paths | URI encoding differences | Always use `Uri.toString()` for cache keys — it encodes consistently regardless of platform. |
| Multiple diagnostics collections for same file | Two extensions both reporting errors | `languages.getDiagnostics(uri)` returns combined array from all collections. Our severity calculation naturally handles multiple entries. |
| Virtual file systems (scheme != file) | `fsPath` is undefined | Check `uri.scheme === 'file'` before caching. Skip non-file URIs. |
| Workspace trust | Extension may run in untrusted mode | Mark extension as supporting workspace trust in `package.json` (`capabilities.untrustedWorkspaces.supported`). |

### 10.5 Unsupported Scenarios

| Scenario | Reason | Workaround |
|---|---|---|
| Showing decoration icons (not badge text) | VS Code API limitation — no file icon overlay API | Use badge text like "!" or "✕". Consider a custom view if icons are critical. |
| Coloring folder expand/collapse icon | API only allows badge text + color | Accept limitation. The folder name itself gets colored via `propagate`. |
| Real-time animated decorations | Badges are static | Accept limitation. Decorations update instantly via `onDidChangeFileDecorations`. |
| In-editor decorations (gutter, line numbers) | Out of scope — this is Explorer-only | FileDecorationProvider is specifically for Explorer. In-editor diagnostics are already handled by VS Code natively. |

---

## 11. Best Practices

### 11.1 From Popular VS Code Extensions

| Extension | Practice | Adoption |
|---|---|---|
| **GitLens** | Modular architecture, dependency injection | Mirroring with separated modules. |
| **Error Lens** | Efficient diagnostic reading from `languages.getDiagnostics()` | Following same pattern — read-only, never create collections. |
| **Bracket Pair Colorizer** | Event debouncing for performance | Adopting 50ms debounce pattern. |
| **Material Icon Theme** | FileDecorationProvider usage pattern | Following same provider registration pattern. |
| **VS Code built-in Git** | Incremental file status tracking | Mirroring cache + event approach. |

### 11.2 General Best Practices

- **All cache reads in `provideFileDecoration` are synchronous.** No awaits, no promises.
- **No global state.** All state lives in explicitly scoped modules or instance variables.
- **Dispose everything.** Every subscription, event emitter, and provider is added to `context.subscriptions`.
- **Test without VS Code.** Pure logic (severity mapping, cache operations, folder propagation) is tested with standard Node.js test runner. Only the provider registration requires the VS Code host.
- **Logging.** Use `console.log` gated behind a `DEBUG` flag (or a `LogLevel` setting). Never log in `provideFileDecoration`.
- **Fail-safe.** If any module's `init()` throws, the extension degrades gracefully (no decorations shown) rather than crashing.

---

## 12. Coding Standards

### 12.1 Language & Tooling

- **TypeScript** strict mode (`strict: true`)
- **ESLint** with `@typescript-eslint` rules
- **Prettier** for formatting (single quotes, trailing commas, 100 char width)
- **Webpack** for bundling (production .vsix should be a single JS file)

### 12.2 Naming Conventions

| Category | Convention | Example |
|---|---|---|
| Interfaces | PascalCase, no `I` prefix | `ProblemStatus`, `CacheEntry` |
| Types | PascalCase | `ProblemSeverity` |
| Enums | PascalCase | `ProblemSeverity.Error` |
| Classes | PascalCase | `DiagnosticsManager` |
| Functions | camelCase | `computeFolderStatus()` |
| Variables | camelCase | `dirtyUris` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_IGNORE_PATTERNS` |
| Private fields | `readonly` wherever possible | `private readonly cache: ProblemCache` |
| Event emitters | Suffix with `Emitter` | `changeEmitter: EventEmitter<Uri[]>` |
| File names | camelCase matching export | `diagnosticsManager.ts` exports `DiagnosticsManager` |

### 12.3 File Organization

Each file follows this order:

```
1. Imports (grouped: external → internal)
2. Types/interfaces (if not in core/types.ts)
3. Constants
4. Class/function implementation
5. Export
```

### 12.4 Error Handling

- Use `Result<T, E>` pattern for fallible operations in pure logic
- Never throw from `provideFileDecoration` — return `undefined`
- Use custom error classes defined in `core/errors.ts`
- Log errors with context, never silently catch

---

## 13. Future Scalability

### 13.1 Version Roadmap

| Version | Features | Est. Effort |
|---|---|---|
| 0.1 | File decorations, real-time updates, configurable colors | 2-3 weeks |
| 0.2 | Folder propagation, ignore patterns, refresh command | 1-2 weeks |
| 0.3 | Multi-root support, badge counts, tooltip detail | 1 week |
| 1.0 | Stable API, full test coverage, marketplace publication | 1 week |

### 13.2 Future Enhancements

| Feature | Feasibility | Notes |
|---|---|---|
| Problem count in Status Bar | Easy | `window.setStatusBarMessage()` |
| Click on decoration → open Problems panel | Easy | `commands.executeCommand('workbench.actions.view.problems')` |
| Custom icons instead of badge text | Medium | Could use `ThemeIcon` if API supports it; otherwise fallback to unicode |
| Per-language severity thresholds | Medium | Extend config to `problemExplorer.languageOverrides` |
| Diagnostic trend visualization | Hard | Would require persisting history — out of scope for Explorer-only |
| Inline explorer decorations (file background) | Low | VS Code API limitation — no background color on Explorer items |
| Configurable badge style (icon, count, dot) | Medium | Add `badgeStyle: 'text' | 'count' | 'dot'` setting |

### 13.3 Extension API for Other Extensions

Future versions could expose a public API:

```typescript
// In extension.ts:
export function activate(context: ExtensionContext): ProblemExplorerAPI {
  return {
    getProblemStatus(uri: Uri): ProblemStatus | undefined,
    onDidChangeProblemStatus: Event<{ uri: Uri; status: ProblemStatus }>,
    refresh(): void,
  };
}

interface ProblemExplorerAPI {
  getProblemStatus(uri: Uri): ProblemStatus | undefined;
  onDidChangeProblemStatus: Event<{ uri: Uri; status: ProblemStatus }>;
  refresh(): void;
}
```

This would allow other extensions to query problem status or react to changes.

---

## 14. Recommendations

### 14.1 Architecture Decisions

| Decision | Recommendation | Rationale |
|---|---|---|
| Rendering mechanism | `FileDecorationProvider` over custom TreeView | 10x less code. No need to rebuild Explorer. Works with user's existing Explorer layout. |
| Data cache | In-memory `Map` over `globalState` | No persistence needed. State is rebuilt on each activation. |
| Event handling | Debounced over synchronous | Prevents UI jank during rapid typing. |
| Folder propagation | Computed ancestor walk over cached tree | Less memory, simpler code, no sync issues with filesystem. |
| Configuration | VS Code's `workspace.getConfiguration` over custom config file | Native Settings UI integration, familiar UX. |
| Bundling | Webpack over tsc-only | Smaller .vsix, faster load, tree-shaken dependencies. |

### 14.2 Items to Address Before Coding

1. **Choose the extension ID and publisher name** — Pick a unique `publisher.name` for `package.json`
2. **Define the exact color scheme** — Decide default error/warning colors (recommend `editorError.foreground` and `editorWarning.foreground` references)
3. **Set up the build pipeline** — `yo code` scaffolding, then Webpack config
4. **Write integration tests first** — Test with a known workspace before writing the provider

### 14.3 Phase 0 Completion Checklist

- [x] API research complete
- [x] Architecture designed
- [x] Folder structure defined
- [x] Data structures selected
- [x] Performance strategy documented
- [x] Risks identified with mitigations

### 14.4 Next Steps (Phase 1: Implementation)

1. Scaffold extension with `yo code`
2. Implement `core/types.ts` and `core/constants.ts`
3. Implement `CacheLayer` + `LruCache`
4. Implement `DiagnosticsManager`
5. Implement `DecorationEngine` with `FileDecorationProvider`
6. Implement `FolderStatusManager`
7. Implement `ConfigurationManager`
8. Implement `CommandManager`
9. Wire everything in `extension.ts`
10. Write unit tests for all modules
11. Manual testing with real projects
12. Add `package.json` contributions (commands, colors, configuration)

---

## 15. Final Conclusions

1. **Problem Explorer is highly feasible.** The core requirement — highlighting files and folders by diagnostic severity in the Explorer — maps cleanly to the stable `FileDecorationProvider` API.

2. **The primary technical risk is performance under high diagnostic churn.** This is mitigated by:
   - Synchronous cache lookups in the decoration provider
   - Debounced diagnostic event processing
   - Incremental (never full) updates at runtime
   - LRU eviction for memory management

3. **The architecture is designed for maintainability.** Six independent modules with clear responsibilities, a single direction of data flow, and no circular dependencies. Each module has <200 lines of core logic.

4. **Folder decoration propagation is the most nuanced feature.** The API docs explicitly warn that propagated decorations must be signaled via `onDidChangeFileDecorations`. The `FolderStatusManager` exists specifically to solve this.

5. **The extension can be built without any proposed APIs** — everything uses stable, documented VS Code surfaces.

6. **Multi-root workspace support is baked in from the start.** The two-level cache structure (`Map<WorkspaceFolder, …>`) means multi-root is not an afterthought.

7. **Marketplace quality is achievable within 3-4 weeks** by a single developer following the architecture in this document.
