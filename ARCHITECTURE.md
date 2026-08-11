# Problem Explorer — Architecture (v2)

## Overview

Problem Explorer v2 is a pnpm monorepo. The diagnostics engine ships as a set of `@pe/*` packages (`packages/*` and `packages/providers/*`), and the VS Code extension (`packages/extension`) consumes them. Diagnostics from external tools (tsc, eslint, ruff) and from VS Code's own language servers are scanned asynchronously, normalized into a shared store, and rendered as file/folder badges in the Explorer via the `FileDecorationProvider` API.

The v1-era root `src/` tree has been removed; all implementation lives under `packages/`.

## Workspace layout

```
packages/
  core/                # shared types, uri keys, config validation, events
  store/               # ProblemStore — single source of truth (adds/updates/removes/clears)
  scheduler/           # provider registry, scan scheduler, bounded queues
  workspace-index/     # workspace/root bookkeeping (persisted metadata)
  impact-analyzer/     # diagnostic caching/change impact analysis
  api/                 # DiagnosticsAPI — programmatic surface for consumers
  provider-sdk/        # base provider contract + diagnostic mapping
  providers/
    base/              # abstract provider (spawn, parse, report)
    tsc/               # TypeScript compiler scans
    eslint/            # ESLint scans
    ruff/              # Ruff (Python) scans
    vscode-realtime/   # VS Code language-server diagnostics bridge
  extension/           # the VS Code extension host (VSIX)
```

## Data flow

```
tool output (tsc/eslint/ruff, VS Code diagnostics)
        |
        v
providers (spawn + parse -> normalized diagnostics)
        |
        v
scheduler (provider registry, scan queue, concurrency, scheduling)
        |
        v
ProblemStore (@pe/store — single source of truth, evented)
        |
        v
extension UI layer (packages/extension)
  - DecorationEngine    -> FileDecorationProvider badges (E/W/I, counts)
  - RealtimeDiagnosticsBridge -> save-triggered incremental rescan
  - StatusBar, commands (rescan/scan/toggle), config
        |
        v
VS Code Explorer
```

## Extension host (`packages/extension`)

- `src/extension.ts` — activation entry point; wires config, engine, decorations, realtime bridge, status bar.
- `src/config.ts` — reads `problemExplorer.*` settings (enable, provider toggles per tool, timeouts, badges, realtime, ruff options).
- `src/engine.ts` — wires the installed `@pe/*` engine (scheduler/provider registration) and configures scan startup.
- `src/decorations.ts`, `src/badge.ts` — `FileDecorationProvider` implementation and badge formatting.
- `src/realtime.ts` — bridges VS Code diagnostic events and save events into incremental scans.
- `src/severity.ts`, `src/ignore.ts`, `src/commands.ts`, `src/statusBar.ts` — severity mapping, ignore patterns, commands, status bar.

The extension is packaged with vsce into `packages/extension/*.vsix` (`.vscodeignore` lives in `packages/extension/`).

## Build, test, CI

- Typecheck: root `tsc -b` (project references over all packages) plus per-package `typecheck:tests`.
- Unit/integration tests: vitest across `packages/**/*.{test,spec}.ts`; real-tool e2e suites run tsc/eslint/ruff for real (skip when the binary is absent).
- Electron smokes (extension host): `test:electron` (dev build) and `test:electron:packaged` (installs the produced VSIX) under `packages/extension/test-electron/`.
- CI (`.github/workflows/ci.yml`): Ubuntu + Windows matrix on main, gate job on branches — typecheck → tests → lint → VSIX packaging → packaged Electron smoke (xvfb on Linux).
- Release (`.github/workflows/release.yml`): tag pushes package the VSIX, publish to the VS Code Marketplace (dry-run), and create a GitHub release with the VSIX attached. Release steps fail hard on error.

## History

v1 (pre-2.0) shipped a single-file-tree extension under root `src/`. The v2 milestone replaced it with the `@pe/*` engine packages; the legacy tree was removed in the v2 stabilization cleanup. Historical v1 analysis documents (`docs/phase-0-*`, `REVIEW.md`, `ROADMAP.md`) are retained as records.