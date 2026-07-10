# Problem Explorer — Roadmap

> **Goal:** Transform the VS Code Explorer into a real-time visual map of project diagnostics.
>
> **Strategy:** One phase per milestone. Each phase delivers a shippable, usable increment.

---

## Phase 0 — Foundation (complete)

> ✅ Project skeleton, tooling, scaffolding, and the core `activate`/`deactivate` contract.

### Task 0.1 — Scaffold the extension

- [x] Run `yo code` to generate the extension scaffold
- [x] Choose a unique publisher ID and extension ID (Yjaatouri / problem-explorer)
- [x] Configure `package.json` with metadata (name, publisher, display name, description, categories)
- [x] Set up `tsconfig.json` with strict mode
- [x] Set up ESLint + Prettier configs

### Task 0.2 — Configure the build pipeline

- [x] Install and configure Webpack for production bundling
- [x] Add `npm run build`, `npm run watch`, `npm run lint` scripts
- [x] Configure `.vscodeignore` to exclude dev files from .vsix
- [x] Verify `F5` launches the extension in a development host

### Task 0.3 — Create the folder structure

- [x] Create all directories under `src/` as defined in the architecture doc
- [x] Create `src/core/types.ts` with all shared type definitions
- [x] Create `src/core/constants.ts` with all constants
- [x] Create `src/core/errors.ts` with custom error classes

### Task 0.4 — Write the empty `activate`/`deactivate`

- [x] `extension.ts` exports `activate` and `deactivate` functions
- [x] `activate` logs a startup message
- [x] `deactivate` is a no-op
- [x] Verify webpack build succeeds (compiled to dist/extension.js)

---

## Phase 1 — Core Diagnostics Engine

> Implement reading, caching, and managing diagnostics. No UI yet.

### Task 1.1 — Implement the CacheLayer

- [x] Create `src/cache/lruCache.ts` with generic LRU eviction
- [x] Create `src/cache/cacheLayer.ts` with `ProblemCache` class
- [x] Implement `get(uri): ProblemStatus | undefined` — O(1)
- [x] Implement `set(uri, status): boolean` — returns true if changed
- [x] Implement `delete(uri)` and `clear()`
- [x] Implement workspace-folder-aware isolation
- [x] Write unit tests for cache (hit, miss, eviction, overwrite)

### Task 1.2 — Implement the SeverityMapper

- [x] Create `src/diagnostics/severityMapper.ts`
- [x] Implement `toProblemSeverity(diagnostics: Diagnostic[]): ProblemSeverity`
- [x] Implement `toProblemStatus(diagnostics: Diagnostic[]): ProblemStatus`
- [x] Count errors, warnings, infos separately
- [x] Write unit tests (empty, errors only, warnings only, mixed, undefined)

### Task 1.3 — Implement the DiagnosticsManager

- [x] Create `src/diagnostics/diagnosticsManager.ts`
- [x] Implement `fullScan()` — calls `languages.getDiagnostics()`, seeds cache
- [x] Implement `processChanges(uris: Uri[])` — incremental update from event
- [x] Subscribe to `languages.onDidChangeDiagnostics`
- [x] Integrate with CacheLayer (write-through on every change)
- [x] Publish internal `onDiagnosticsChanged` event for other modules
- [x] Write unit tests (mock `languages.getDiagnostics`)

### Task 1.4 — Implement the IgnoreFilter

- [x] Create `src/performance/ignoreFilter.ts`
- [x] Implement `isIgnored(uri: Uri, patterns: string[]): boolean`
- [x] Default ignore patterns (`**/node_modules/**`, `**/.git/**`, etc.)
- [x] Apply filter in CacheLayer set() — skip ignored URIs
- [x] Write unit tests (glob matching against known paths)

### Task 1.5 — Implement debounce and batch utilities

- [x] Create `src/performance/debounce.ts`
- [x] Create `src/performance/batch.ts`
- [x] Create `src/performance/throttle.ts`
- [x] Write unit tests (timing-sensitive, use fake timers)

---

## Phase 2 — Decoration Engine

> Wire diagnostics to the Explorer via `FileDecorationProvider`. This is where the extension becomes visible.

### Task 2.1 — Implement the DecorationEngine

- [x] Create `src/decoration/decorationEngine.ts`
- [x] Implement `FileDecorationProvider` interface
- [x] `provideFileDecoration(uri)` → synchronous cache lookup → `FileDecoration | undefined`
- [x] Implement `onDidChangeFileDecorations` event emitter
- [x] Register provider in `extension.ts` via `window.registerFileDecorationProvider()`
- [x] Test: decorations appear on files with diagnostics

### Task 2.2 — Implement the BadgeFormatter

- [x] Create `src/decoration/badgeFormatter.ts`
- [x] Implement `getBadge(severity: ProblemSeverity, counts: Counts): string`
- [x] Supported badges: `E`, `W`, `!`, `""` (empty for clean)
- [x] Make badge style configurable (`'letter'`, `'count'`, `'dot'`, `'none'`)
- [x] Write unit tests

### Task 2.3 — Implement the ColorProvider

- [x] Create `src/decoration/colorProvider.ts`
- [x] Implement `getErrorColor(): ThemeColor`
- [x] Implement `getWarningColor(): ThemeColor`
- [x] Implement `getInfoColor(): ThemeColor`
- [x] Default colors reference built-in `editorError.foreground` and `editorWarning.foreground`
- [x] Integrate with ConfigurationManager for user overrides

### Task 2.4 — Wire DecorationEngine to DiagnosticsManager

- [x] In `extension.ts`: when `DiagnosticsManager.onDiagnosticsChanged` fires, call `DecorationEngine.fireDidChange(uris)`
- [x] Debounce the firing using the 50ms debounce utility
- [x] Collect dirty URIs in a `Set<string>` during debounce window
- [x] Test: typing in a TypeScript file updates decorations in real time

### Task 2.5 — Add `package.json` contributions

- [x] Contribute two custom colors: `problemExplorer.errorForeground`, `problemExplorer.warningForeground`
- [x] Contribute `onStartupFinished` activation event
- [x] Contribute `problemExplorer.refresh` command
- [x] Define `configuration` section with settings:
  - `problemExplorer.enabled` (boolean)
  - `problemExplorer.showWarnings` (boolean)
  - `problemExplorer.errorColor` (string, references custom color)
  - `problemExplorer.warningColor` (string, references custom color)
  - `problemExplorer.ignorePatterns` (array of strings)
  - `problemExplorer.badgeStyle` (enum: 'letter' | 'count' | 'dot' | 'none')

---

## Phase 3 — Folder Propagation

> Folders reflect the diagnostic status of their children. This is the most complex feature.

### Task 3.1 — Implement the FolderStatusManager

- [ ] Create `src/folder/folderStatusManager.ts`
- [ ] Implement `updateAncestors(fileUri: Uri): Uri[]` — walks from file to root
- [ ] Implement `recomputeFolderStatus(folderUri: Uri): ProblemStatus`
- [ ] Implement `rebuildAll()` — computes all folder statuses from cache
- [ ] Worst-severity-wins aggregation rule
- [ ] Write unit tests (nested folders, mixed statuses, empty folders)

### Task 3.2 — Implement the PropagationStrategy

- [ ] Create `src/folder/propagationStrategy.ts`
- [ ] Define aggregation function: `aggregate(children: ProblemStatus[]): ProblemStatus`
- [ ] Error > Warning > Info > None
- [ ] Sum counts from all children
- [ ] Write unit tests

### Task 3.3 — Wire FolderStatusManager into the change flow

- [ ] In `extension.ts`: after DiagnosticsManager processes a change, call `FolderStatusManager.updateAncestors(uri)`
- [ ] Collect all ancestor URIs into the dirty set alongside the file URI
- [ ] Test: changing a file's diagnostics updates all parent folders up to the workspace root

### Task 3.4 — Handle collapsed folders correctly

- [ ] `provideFileDecoration` is not called for collapsed folders until expanded
- [ ] Ensure `onDidChangeFileDecorations` fires for folder URIs so VS Code re-queries when expanded
- [ ] Test: collapse a folder, change a file inside it, expand → decoration is correct

---

## Phase 4 — Configuration & Commands

> User-facing controls for behavior, appearance, and manual refresh.

### Task 4.1 — Implement the ConfigurationManager

- [ ] Create `src/config/configManager.ts`
- [ ] Implement `getConfig(): Config` — reads all `problemExplorer.*` settings
- [ ] Subscribe to `workspace.onDidChangeConfiguration`
- [ ] Filter to only `affectsConfiguration('problemExplorer')` changes
- [ ] Trigger `DecorationEngine.refresh()` on relevant config changes
- [ ] Write unit tests (mock `workspace.getConfiguration`)

### Task 4.2 — Implement the CommandManager

- [ ] Create `src/commands/commandManager.ts`
- [ ] Create `src/commands/refresh.ts` — full diagnostic rescan + re-render
- [ ] Create `src/commands/toggle.ts` — enable/disable decorations
- [ ] Register all commands in `extension.ts`
- [ ] Add keyboard shortcut for refresh (Ctrl+Shift+P → "Problem Explorer: Refresh")
- [ ] Test: commands execute and decorations update correctly

### Task 4.3 — Implement the WorkspaceManager

- [ ] Create `src/workspace/workspaceManager.ts`
- [ ] Implement `getWorkspaceFolders(): WorkspaceFolder[]`
- [ ] Subscribe to `workspace.onDidChangeWorkspaceFolders`
- [ ] On folder added: run diagnostics scan for that folder
- [ ] On folder removed: clear cache for that folder
- [ ] Write unit tests (multi-root scenarios)

### Task 4.4 — Handle workspace trust

- [ ] Set `capabilities.untrustedWorkspaces.supported` to `limited` or `true` in `package.json`
- [ ] Test: extension behaves correctly in untrusted mode (no decorations shown, command warns user)

---

## Phase 5 — Polish, Testing & Release

> Production readiness: tests, edge cases, performance validation, marketplace submission.

### Task 5.1 — Write full test suite

- [ ] Unit tests for every module (target: >90% coverage)
- [ ] Integration tests using VS Code test runner with a sample workspace
- [ ] Test scenarios:
  - Empty workspace
  - Single file with errors
  - 1000 files with random diagnostics
  - Multi-root workspace with overlapping file names
  - Rapid typing (1000 diagnostic events in 1 second)
  - Workspace with no language server
  - Extremely deep folder nesting (50 levels)

### Task 5.2 — Performance validation

- [ ] Profile `provideFileDecoration` latency (< 1µs target)
- [ ] Profile initial activation with a 10k-file workspace (< 200ms target)
- [ ] Profile memory with LRU cache at limit
- [ ] Profile rapid diagnostic change handling
- [ ] Create benchmark script

### Task 5.3 — Edge case hardening

- [ ] Handle workspace-less VS Code window (no folder open)
- [ ] Handle files with non-ASCII/Unicode paths
- [ ] Handle virtual file systems (scheme != `file`)
- [ ] Handle deleted files (evict from cache via file system watcher)
- [ ] Handle extremely long file paths on Windows

### Task 5.4 — Documentation

- [ ] Write complete README with screenshots and animated GIF
- [ ] Write CHANGELOG.md
- [ ] Document all settings in README
- [ ] Add inline code comments for public API surfaces

### Task 5.5 — Packaging & Marketplace

- [ ] Run `vsce package` to produce .vsix
- [ ] Verify .vsix size < 100KB
- [ ] Publish to VS Code Marketplace
- [ ] Set up CI/CD pipeline (GitHub Actions)

---

## Phase 6 — Post-Release Enhancements

> Future capabilities beyond the initial release.

### Task 6.1 — Problem count tooltip

- [ ] Enhance `BadgeFormatter` to include count in tooltip: "3 errors, 5 warnings"
- [ ] Show total in folder hover: "12 errors, 8 warnings across 15 files"

### Task 6.2 — Status bar integration

- [ ] Show total error/warning count in the Status Bar
- [ ] Click → opens Problems panel or runs refresh command

### Task 6.3 — Per-language severity overrides

- [ ] Allow users to configure severity thresholds per language
- [ ] Example: mark Python type errors as warnings, not errors

### Task 6.4 — Public extension API

- [ ] Export `ProblemExplorerAPI` from `activate()` for other extensions
- [ ] `getProblemStatus(uri): ProblemStatus | undefined`
- [ ] `onDidChangeProblemStatus: Event<{ uri, status }>`

### Task 6.5 — Diagnostic trend visualization

- [ ] Track diagnostic count history in `globalState`
- [ ] Show mini sparkline in tooltip (future stretch goal)

---

## Summary

| Phase | Focus | Deliverables | Est. Duration |
|---|---|---|---|
| 0 | Foundation | Scaffold, tooling, empty extension | 1 day |
| 1 | Diagnostics Engine | Cache, severity mapper, diagnostics manager, ignore filter, debounce | 3-4 days |
| 2 | Decoration Engine | FileDecorationProvider, badges, colors, real-time update | 3-4 days |
| 3 | Folder Propagation | FolderStatusManager, ancestor walk, aggregation | 2-3 days |
| 4 | Configuration & Commands | Settings, commands, multi-root, workspace trust | 2-3 days |
| 5 | Polish & Release | Tests, perf, docs, marketplace | 3-5 days |
| 6 | Post-Release | Tooltip, status bar, API, per-language | On-going |

**Total to v1.0:** ~2-3 weeks for a single developer.
