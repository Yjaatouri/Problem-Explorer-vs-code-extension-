# Changelog

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
