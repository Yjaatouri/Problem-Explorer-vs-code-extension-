# Task: Fix All Test Failures & Ensure Multi-Language AutoScan Works

## Summary

Fix the 51 pre-existing test failures in the Problem Explorer VS Code extension. Also validate that the AutoScan architecture (file save → provider scan → ProblemStore write → decoration update) works for all languages (TypeScript, JavaScript, ESLint, and any future language). The codebase is at `C:\Users\Jbilo\Desktop\Problem Explorer (vs code extension)`.

**Build/test commands:**
- `npx tsc --project tsconfig.test.json` (compile)
- `npm test` (run full test suite)
- Tests run in a headless VS Code environment via `@vscode/test-electron`

## Architecture Overview

### Scan Flow (user saves a file → decoration appears)
1. VS Code fires `workspace.onDidSaveTextDocument`
2. `AutoScanController.onFileSave(uri)` calls `scheduler.routeFileSave(uri)`
3. `ScanScheduler.routeFileSave(uri)` extracts file extension (`.ts`, `.js`, etc.), looks up the owning provider via `registry.getOwner(ext)`, checks provider config's `autoScan` gate, then calls `this.submit()`
4. `submit()` creates a `ScanJob` with priority from event tier + provider priority, deduplicates, debounces, then calls `refreshWithLocks()`
5. `refreshWithLocks()` calls `manager.refreshByNames([ownerName], [uri])` through a per-provider lock
6. `DiagnosticProviderManager.refreshByNames()` calls the provider's `refresh()` or `refreshUris()`
7. The provider runs its tool (tsc, eslint, etc.) and writes results to `ProblemStore.set(uri, state, providerName)`
8. `ProblemStore.set()` fires `onDidChange` events
9. `VSDiagnosticsProvider` listens to `manager.onDidUpdateAll`, debounces, then calls `decorationEngine.fireDidChange()` + `folderStatusManager.rebuildAll()` + `statusBarManager.update()`
10. VS Code calls `DecorationEngine.provideFileDecoration(uri)` for each visible file → reads from `ProblemStore.get(uri)` → returns badge

### Provider Registration
- Each provider has a `.module.ts` file (e.g. `TscDiagnosticProvider.module.ts`) that exports a `register(registry, ctx)` function
- `ALL_PROVIDER_MODULES` in `src/providers/index.ts` lists all providers
- `extension.ts` calls `registerAllProviders()` once during activation
- Each provider has a `ProviderDescriptor` with: `id`, `priority`, `capabilities.extensions` (file extensions it owns), `type` ('scanner' | 'realtime')
- `ProviderRegistry.rebuildOwnership()` builds the extension→owner map from descriptors, sorting by priority (highest wins), skipping realtime providers and disabled providers

### Current Providers
| Provider | Extensions | Priority | Type |
|----------|-----------|----------|------|
| `vscodeDiagnostics` | `[]` (none) | 5 | realtime |
| `tsc` | `.ts`, `.tsx` | 10 | scanner |
| `eslint` | `.js`, `.jsx`, `.vue`, `.svelte` | 9 | scanner |

### Key Files
- `src/scanner/AutoScanner.ts` — `AutoScanController`: listens to VS Code file events, routes to ScanScheduler
- `src/scanner/ScanScheduler.ts` — Central scheduler: submit(), debounce, dedup, cancel, priority queue, per-provider locks, reconciliation
- `src/scanner/ScanJob.ts` — Types: ScanJob, ScanJobRequest, ScanJobResult, ScanPriority, ScanSource
- `src/providers/ProviderRegistry.ts` — Registration, ownership mapping, priority, capabilities
- `src/providers/DiagnosticProviderManager.ts` — Provider lifecycle (register/unregister), refreshAll/refreshByNames, event aggregation
- `src/providers/index.ts` — ProviderRegistrationContext, ALL_PROVIDER_MODULES, registerAllProviders()
- `src/providers/DiagnosticProvider.ts` — DiagnosticProvider interface
- `src/providers/TscDiagnosticProvider.ts` — TypeScript scanner
- `src/providers/EslintDiagnosticProvider.ts` — ESLint scanner
- `src/providers/VSCodeDiagnosticProvider.ts` — VS Code realtime provider
- `src/providers/VSDiagnosticsProvider.ts` — Legacy wrapper (used in tests)
- `src/providers/BaseProblemProvider.ts` — Base class
- `src/store/ProblemStore.ts` — O(1) diagnostic store with ownership, batching, events
- `src/trend/trendTracker.ts` — Trend tracking with MementoStorageProvider
- `src/core/types.ts` — ProblemState, ProblemSeverity, ProviderCapabilities, ScanProgress, ProviderConfig
- `src/decoration/decorationEngine.ts` — File decoration provider
- `src/folder/folderStatusManager.ts` — Folder aggregation
- `src/telemetry/monitors/` — Telemetry monitors (AutoScannerMonitor, DiagnosticsMonitor, DecorationMonitor, FolderMonitor, StoreMonitor, ProviderMonitor, TimerMonitor, EventPipelineMonitor, SnapshotSystem)
- `src/test/suite/` — All test files

## Categorized Failures (51 total)

### Category 1: ProblemStore Event System (3 failures)
**Files: `src/store/ProblemStore.ts`, `src/test/suite/problemStore.test.ts`**

#### Failure 42: `clear fires cleared event` — expects 1 event, gets 2
- `ProblemStore.clear()` (line 124-137) fires per-entry `removed` events (line 127) AND a `cleared` event (line 135)
- With 1 stored entry, this fires 2 events (`removed` + `cleared`)
- Test expects only the `cleared` event
- **Fix**: `clear()` should fire EITHER per-entry events OR a batch event, not both. Since it already fires individual `removed` events, the final `cleared` event is redundant. Remove the `cleared` event (lines 134-136) when per-entry events are fired. OR: only fire the `cleared` event and skip per-entry events.

#### Failure 43: `individual events suppressed during batch` — expects 1 event, gets 2
- `clear()` at line 126-128 fires per-entry `removed` events regardless of `batchDepth`
- Test calls `beginBatch()`, then `set()`, `delete()`, `clear()`, then `endBatch()`
- `clear()` fires 1 `removed` event (ignoring batchDepth=1)
- `endBatch()` fires 1 `batch` event
- Total: 2 events, expected: 1 (`batch`)
- **Fix**: `clear()` should check `batchDepth` before firing per-entry events (like `set()` and `delete()` do)

#### Failure 44: `movePrefix fires prefixMoved event` — expects 1 event, gets 3
- `movePrefix()` (lines 179-227) fires per-entry `removed` + `added` events AND a `prefixMoved` event
- With 1 stored entry, this fires 3 events (`removed` + `added` + `prefixMoved`)
- Test expects only the `prefixMoved` event
- **Fix**: `movePrefix()` should fire EITHER per-entry events OR a `prefixMoved` event, not both. Since `prefixMoved` conveys the same info, skip per-entry events when fireing `prefixMoved`.

### Category 2: Telemetry Monitors Not Connected (14+ failures)
**Files: `src/telemetry/monitors/*.ts`, `src/test/suite/vsCodeMonitors.test.ts`, `src/test/suite/telemetryMonitors.test.ts`**

These monitors wrap/patch VS Code objects and extension methods to publish telemetry events, but the tests show `0 !== 1` (events not firing) or `false !== true` (predicate not matching).

#### Sub-failures:
1. `AutoScannerMonitor` (3 tests) — `provider.scan`, `autoscan.providerExecution`, `autoscan.cancel` events not firing
2. `DiagnosticsMonitor` (3 tests) — `diagnostics.updateUri`, `diagnostics.fullScan`, `diagnostics.flushUpdates` not firing
3. `DecorationMonitor` (3 tests) — `decoration.refresh.start`, `decoration.provide`, wrapping/restoring not working
4. `FolderMonitor` (2 tests) — `folder.updateAncestors`, `folder.rebuildAll`, wrapping/restoring not working
5. `BusTelemetryReporter` (2 tests) — events not published: `0 !== 1`
6. `StoreMonitor` (3 tests) — `store.set`, `store.delete`, `store.clear` not firing
7. `ProviderMonitor` (2 tests) — `provider.registry`, `provider.lifecycle` not firing
8. `TimerMonitor` (1 test) — timeout
9. `EventPipelineMonitor` (1 test) — duplicate events not detected
10. `TimelineGenerator` (1 test) — events not stored: `0 !== 3`
11. `SnapshotSystem` (1 test) — `4 !== 3` (captures store state count mismatch)

**Root causes to investigate**:
- Are the monitors actually wrapping/monkey-patching the original objects?
- Is the event bus (`BusTelemetryReporter`) connected and firing?
- Do the test mock objects match what the monitors expect?
- Test 11: `fireDidChange` not restored to original function (shows `bound` vs unbound)
- `SnapshotSystem` reports 4 entries instead of 3 — could be related to the ProblemStore's clear() issue where extra events are created

### Category 3: TrendTracker/MementoProvider in Tests (2 failures)
**Files: `src/trend/trendTracker.ts`, `src/providers/VSDiagnosticsProvider.ts`**

#### Failure 49 & 51: `this.memento.get is not a function`
Tests create a `TrendTracker` without a proper `StorageProvider` (or pass a non-Memento object). When `VSDiagnosticsProvider`'s debounced callback fires `trendTracker.takeSnapshot()`, it calls `this.storage.get(...)` which falls through to `MementoStorageProvider.get()` which calls `this.memento.get(...)` — but `this.memento` is undefined or not a Memento.

**Root cause**: The `VSDiagnosticsProvider` constructor creates a `TrendTracker` but test setups don't provide a proper storage provider. The TrendTracker uses `defaultStorageProvider` (a no-op provider) when no storage arg is passed, which should be safe. But maybe some test paths pass a partial object or the VSDiagnosticsProvider creates a TrendTracker with a real MementoStorageProvider using an invalid memento.

**Fix**: Ensure all test setups that create VSDiagnosticsProvider also provide a valid storage provider, OR make VSDiagnosticsProvider handle TrendTracker errors gracefully.

### Category 4: TscRunner AbortSignal (2 failures)
**Files: `src/typescript/TscRunner.ts`, `src/test/suite/tscRunner.test.ts`**

#### Failures 15-16: `false !== true` for cancellation support
The `TscRunner` doesn't actually abort the child process when the AbortSignal fires. The `spawn()` method receives an `AbortSignal` but either:
- Doesn't listen for the `abort` event on the signal
- Doesn't call `childProcess.kill()` when aborted
- The test expects `aborted` property to be `true` on the result, but the runner doesn't set it

**Fix**: In `TscRunner.spawn()`, add `signal.addEventListener('abort', () => childProcess.kill())` and ensure the result includes `aborted: true`.

### Category 5: TscDiagnosticProvider Test Infrastructure (2 failures)
**Files: `src/test/suite/tscDiagnosticProvider.test.ts`**

#### Failures 17-18: `assert.ok(aState)` / `assert.ok(state)` fails — no diagnostics written to store
The tests create a `TscDiagnosticProvider` but it has no real TypeScript project files to scan. The provider's `runScan()` returns no diagnostics, so `store.get(uri)` returns `undefined`.

**Fix**: Either:
- Create a minimal TypeScript project in the test sandbox with known errors
- Or mock the TscRunner to return predefined output
- The `performanceBenchmark.test.ts` shows how to mock: it creates `makeFakeTscDelegate()` that returns canned output

### Category 6: ScanCommand Test Infrastructure (3 failures)
**Files: `src/test/suite/scanCommand.test.ts`**

#### Failures 36-38: scan doesn't write to store
The test creates a `TscDiagnosticProvider` directly but the provider's `refresh()` doesn't produce diagnostics because there are no real TS projects to scan. The `scan updates existing entries` test expects `state.errorCount === 1` but gets `undefined`.

**Fix**: Same as Category 5 — provide a mocked TscRunner or create a test TS project.

### Category 7: ScannerValidation Missing Sample Projects (5 failures)
**Files: `src/test/suite/scannerValidation.test.ts`**

#### Failures 31-35: Vite, NestJS, Monorepo, Large project tests fail
These tests expect to scan sample projects located in `src/test/fixtures/` or similar. The sample projects either don't exist or are incomplete. Expected error counts don't match actual (e.g., expects 4000 errors but gets 80).

**Fix**: Create the missing sample projects with known error counts, or update the expected counts to match what the actual projects produce.

### Category 8: ProviderRegistry Priority Ordering (1 failure)
**Files: `src/test/suite/providerRegistry.test.ts`**

#### Failure 39: `all() returns tsc first, but actual is vscodeDiagnostics`
The test registers `tsc` (priority 10) and `vscodeDiagnostics` (priority 5). When enumerating via `all()`, it expects `tsc` first (highest priority). But `vscodeDiagnostics` comes first.

**Root cause**: `ProviderRegistry.all()` delegates to `dpm.all()` which returns providers in registration order, not priority order. The registry doesn't sort by priority before returning.

**Fix**: Sort the result of `all()` by descriptor priority descending.

### Category 9: ProjectResolver Workspace TypeScript (2 failures)
**Files: `src/typescript/ProjectResolver.ts`, `src/test/suite/projectResolver.test.ts`**

#### Failures 40-41: doesn't fall back to VS Code TypeScript
The tests expect `ProjectResolver` to fall back to VS Code's bundled TypeScript when the workspace module is missing or `useWorkspaceVersion` is false. But the resolver can't find VS Code's TypeScript path in the test environment.

**Fix**: Either mock the VS Code TypeScript path, or provide a fallback TypeScript in the test environment.

### Category 10: MultiProviderIntegration Scenario 2 (1 failure)
**Files: `src/test/suite/multiProviderIntegration.test.ts`**

#### Failure 45: `2 !== 3` — expects 3 entries, gets 2
Two providers write to the same file `fileA`. The test expects 3 distinct entries in the ProblemStore (one per provider per file). But ProblemStore uses URI as the primary key — one URI = one entry. `DummyProvider.initialize()` calls `store.set()` without the provider name argument, so it overwrites the `fileA` entry that `VSCodeDiagnosticProvider` wrote.

**Fix**: Either:
- Change the test expectation to `2` (since fileA is shared, only 2 unique URIs)
- Or change `DummyProvider.initialize()` to pass `this.name` as the 3rd argument, and update the store to support multiple entries per URI (requires architectural change)

### Category 11: Large Workspace Folder Aggregation (2 failures)
**Files: `src/test/suite/largeWorkspace.test.ts`**

#### Failures 46-47: rebuildAll returns no changes, updateAncestors returns no ancestors
After inserting 10,000 files into the store and calling `rebuildAll()` or `updateAncestors()`, no changed folders are detected. The `FolderStatusManager` or `workspaceFolderDelegate` doesn't find the workspace folders for the test URIs.

**Fix**: Ensure the test's workspace folder delegate matches the test URIs (check `workspaceFolderDelegate()` in `largeWorkspace.test.ts`).

### Category 12: FirstSaveAutoScan (3 failures)
**Files: `src/test/suite/firstSaveAutoScan.test.ts`**

#### Failure 48: `DecorationEngine should return decoration for folder aggregate`
After the auto-scan chain runs, `DecorationEngine.provideFileDecoration()` doesn't find the folder aggregate in the store.

#### Failure 49: `this.memento.get is not a function` (same as Category 3)
#### Failure 50: `done() called multiple times` + assertion error
The auto-scan chain test has a race condition — the test callback is called multiple times. The TrendTracker crash (failure 49) causes the test infrastructure to malfunction.

**Fix**: Fix the TrendTracker/memento issue (Category 3), then the auto-scan chain should work. Also ensure the test uses proper done() semantics.

## Multi-Language AutoScan: Making It Work

The extension currently supports 3 languages through 3 providers. The architecture is designed for expansion, but there are gaps:

### What Works
- `ProviderRegistry` maps extensions → provider via `getOwner(ext)`
- `ScanScheduler.routeFileSave()` uses this mapping: extract extension → getOwner → submit scan job
- Providers declare extensions in their descriptor's `capabilities.extensions`
- Adding a new language = create `NewLangDiagnosticProvider.ts` + `NewLangDiagnosticProvider.module.ts` + append to `ALL_PROVIDER_MODULES`

### What Needs Fixing
1. **Test the language-agnostic path**: Verify that `routeFileSave()` works for all extensions by testing with a mock provider for a non-existent language (e.g., `.py`, `.rs`, `.java`)
2. **ProviderRegistry.getOwner()**: Returns `undefined` for unowned extensions (no owner). This means .py/.rs/.java files fall through to vscodeDiagnostics (realtime), which is correct. But is the fallback path tested?
3. **ConfigProvider integration**: `getProviderConfig()` reads from `Config.providers[configSection]`. The `routeFileSave()` checks `providerCfg.autoScan` — validation: does `AutoScanController.updateConfig()` propagate correctly?

### How to validate multi-language support
1. Create a test mock provider for `.py` that registers with `extensions: ['.py']`
2. Create a `.py` file, trigger save, verify the scan job is submitted for the mock provider
3. Verify that `.ts` files route to tsc (priority 10 wins over eslint's `.js` for `.ts`)
4. Verify that `.vue` files route to eslint (priority 9)
5. Verify that `.java` files route to vscodeDiagnostics (no owner)
6. Fix the ProviderRegistry.all() ordering so it returns highest-priority first

## Action Plan

### Phase 1: Fix ProblemStore Event System
1. `clear()`: Remove per-entry `removed` events before the `cleared` event, OR guard them with `batchDepth === 0`
2. `movePrefix()`: Skip per-entry `removed`/`added` events when batchDepth is 0, since `prefixMoved` conveys the same info
3. Run `npx tsc --project tsconfig.test.json && npm test` to verify failures 42-44 are fixed

### Phase 2: Fix TrendTracker in Tests
1. Find all test setups that create VSDiagnosticsProvider without a proper StorageProvider
2. Add `new MementoStorageProvider(new InMemoryMemento())` or pass the default no-op provider
3. Or make VSDiagnosticsProvider catch errors from TrendTracker and log instead of crashing

### Phase 3: Fix TscRunner AbortSignal
1. In `TscRunner.spawn()`, add abort signal listener → `cp.kill()`
2. Ensure the result has `aborted: true` when the signal fires

### Phase 4: Fix ProviderRegistry Priority Order
1. In `ProviderRegistry.all()`, sort by descriptor priority descending before returning

### Phase 5: Connect Telemetry Monitors
1. For each monitor, trace the wrapping/monkey-patching to find why events aren't firing
2. Check if the test's mock objects have the same shape as the real objects
3. Check `BusTelemetryReporter` subscription and event bus connection

### Phase 6: Create Missing Test Infrastructure
1. Create minimal sample projects for ScannerValidation (Vite, NestJS, Monorepo, Large)
2. Create a TscRunner mock helper for tests that need TS diagnostics
3. Fix ProjectResolver fallback to detect VS Code TS in test environment

### Phase 7: Fix MultiProviderIntegration Scenario 2
- Update expected count to 2, or fix DummyProvider to pass provider name

### Phase 8: Fix Large Workspace Folder Tests
- Ensure workspace folder delegate matches test URIs

### Phase 9: Validate Multi-Language AutoScan
1. Create a test with a `.py` mock provider
2. Verify `routeFileSave()` resolves the correct provider
3. Verify the full chain: save → AutoScanController → ScanScheduler → provider → store → decoration
4. Verify that the extension handles languages without a scanner provider gracefully (falls through to vscodeDiagnostics)

## Running Tests
```bash
# Compile
npx tsc --project tsconfig.test.json

# Run all tests (takes ~30s)
npm test

# Run specific test file
npx mocha --require source-map-support/register out/test/suite/problemStore.test.js
```

## Git Workflow
1. Work in small, focused commits
2. Compile and test after each fix
3. Use `git add -A && git commit -m "fix: description" && git push` when done
4. Prioritize: Phase 1 (ProblemStore events) → Phase 2 (TrendTracker) → Phase 3 (TscRunner) → Phase 4 (ProviderRegistry) → Phase 5 (Telemetry) → Phase 6 (Infrastructure) → Phase 7-9 (remaining fixes and validation)