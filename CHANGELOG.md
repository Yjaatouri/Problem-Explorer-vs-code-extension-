# Changelog

## 2.0.0 (2026-08-10)

### Added

- **Scanning engine** — first-class auto-scan: saved files are scanned by configured tools (tsc, eslint) and merged with the editor's realtime diagnostics
- **Multi-provider scheduler** — queued scans with per-provider health checks, so one unhealthy tool can no longer stall the whole workspace
- **Per-provider settings** — enable/disable, auto-scan on save, scan-on-startup, timeout, and extra CLI arguments for both the TypeScript and ESLint providers (`problemExplorer.typescript.*`, `problemExplorer.eslint.*`)
- **ESLint diagnostics** — lint findings (errors, warnings, info) flow into badges via the same pipeline as TypeScript
- **Provider SDK** — `@pe/provider-sdk` contract that scanners implement, shared across engines
- **CI gate** — typecheck, lint, ruff, full test suite (200 tests), packaging, and real VS Code smoke tests (dev host and packaged vsix) run on every pull request, including under Xvfb on Linux

### Changed

- **Publisher** — extension now publishes under the `Yjaatouri` publisher id
- **Timeout hardening** — provider health checks allow up to 30s so cold tool startups (e.g., `eslint --version` under Windows) don't false-fail

## 0.3.0 (2026-07-11)

### Added

- **Resource disposal** — `WorkspaceManager` and `ConfigManager` implement `Disposable` and are properly registered in `context.subscriptions` for clean deactivation; the 5-second refresh timeout is also stored as a disposable

### Fixed

- **Hint diagnostics ignored** — hint-severity diagnostics no longer produce file decorations; hints are excluded from problem counts entirely
- **Severity-override extension matching** — regex `/\.[\w.]+$/` now correctly matches compound extensions like `.d.ts` and `.spec.ts`
- **@types/node alignment** — downgraded from `^26.1.1` to `^20.11.0` to match VS Code 1.90's Node 20 runtime

### Changed

- **vsce replaced** — deprecated `vsce` devDependency replaced with `@vscode/vsce`

### Removed

- **Dead code** — unused `_onDidChangeDiagnostics` EventEmitter in `DiagnosticsManager`; unused `throttle.ts` and `batch.ts` utility modules

## 0.2.0 (2026-07-11)

### Added

- **Tooltip enhancements** — folder badges now show "across N files" when multiple files contribute to the diagnostic count
- **Status bar integration** — total errors, warnings, and infos displayed with codicons; click opens the Problems panel
- **Per-language severity overrides** — remap severity per file extension via `problemExplorer.severityOverrides` (e.g., `.py` errors → warnings)
- **Public extension API** — other extensions can call `getExtension('Yjaatouri.problem-explorer').exports` to access `getProblemStatus(uri)` and `onDidChangeProblemStatus` event
- **Diagnostic trend tracking** — periodic snapshots of total diagnostic counts persisted to global state (every 5 minutes + on change)

## 0.0.1 (2026-07-10)

### Added

- **File decorations** — files with errors, warnings, or info diagnostics show a colored badge directly in the Explorer
- **Folder propagation** — folders automatically show the worst severity of their children, surfacing issues at any depth
- **Real-time updates** — decorations refresh automatically as you type, driven by VS Code diagnostic events
- **Multi-root workspace support** — each workspace folder is tracked independently with its own LRU cache
- **Configurable badge styles** — choose between letter (E/W/I), problem count, dot, or color-only mode
- **Customizable colors** — theme colors contributed as `problemExplorer.errorForeground`, `problemExplorer.warningForeground`, `problemExplorer.infoForeground`, with per-severity hex overrides
- **Ignore patterns** — exclude `node_modules`, `dist`, `build`, `.git`, and more via glob patterns in settings
- **Refresh command** — `problemExplorer.refresh` (Ctrl+Shift+Alt+P) to force a full re-scan
- **Toggle command** — `problemExplorer.toggle` to enable/disable decorations on the fly
- **Workspace trust support** — decorations are disabled in untrusted workspaces
- **Performance optimizations** — LRU cache (10k entries per folder), 50ms debounce on diagnostic events, synchronous `provideFileDecoration` with O(1) cache lookup, lazy folder computation, batch UI updates
- **Edge case hardening** — graceful handling of workspace-less windows, non-ASCII/Unicode paths, virtual file systems, deleted files (via `onDidDeleteFiles`), and extremely long file paths
- **Full test suite** — 12 test files covering cache, diagnostics manager, decoration engine, folder status manager, ignore filter, badge formatter, color provider, config manager, workspace manager, scenarios, edge cases, and performance benchmarks

### Architecture

- Strict layered architecture: Extension Core → Diagnostics Manager → Cache Layer → Decoration Engine → Folder Propagation
- DI/delegate pattern enabling unit testing without VS Code host
- Immutable `ProblemStatus` value objects for safe change detection
- `minimatch` v10 for glob-based ignore pattern matching
