# Problem Explorer

**Stop hunting for broken files.**

Problem Explorer automatically highlights files and folders containing **errors** or **warnings** directly in the VS Code Explorer, making project-wide issues visible at a glance.

![Problem Explorer showing files and folders with error/warning badges in the Explorer](https://github.com/Yjaatouri/Problem-Explorer-vs-code-extension-/raw/main/docs/screenshot.png)

## Features

- **File decorations** â€” files with errors/warnings show a colored badge (E, W, I) in the Explorer
- **Folder propagation** â€” folders inherit the worst severity of their children, so you can see at a glance where issues are
- **Real-time updates** â€” decorations update as you type, with zero perceptible lag
- **Language-agnostic** â€” works with TypeScript, JavaScript, Python, Rust, Go, C++, Java, C#, and any extension that publishes diagnostics
- **Multi-root workspaces** â€” supports multiple workspace folders simultaneously
- **Configurable** â€” customize colors, badges, ignore patterns, and which severities to show
- **Lightweight** â€” LRU-cached, debounced, and optimized for workspaces with 20,000+ files

## How It Works

Instead of this:

```
packages/
â”œâ”€â”€ core/
â”œâ”€â”€ cli/
â””â”€â”€ sdk/
```

You'll see something like:

```
packages/
â”œâ”€â”€ core E
â”‚   â”œâ”€â”€ parser.ts E
â”‚   â”œâ”€â”€ lexer.ts W
â”‚   â””â”€â”€ utils.ts
â”œâ”€â”€ cli
â””â”€â”€ sdk E
    â””â”€â”€ index.ts E
```

Instantly know where to focus.

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to the Extensions view (Ctrl+Shift+X)
3. Search for "Problem Explorer"
4. Click Install

### From VSIX

1. Download the `.vsix` file from the [Releases page](https://github.com/Yjaatouri/Problem-Explorer-vs-code-extension-/releases)
2. In VS Code, go to Extensions â†’ `...` â†’ Install from VSIX...

### Development

```bash
git clone https://github.com/Yjaatouri/Problem-Explorer-vs-code-extension-.git
cd problem-explorer-vs-code-extension
npm install
npm run build
```

Launch the extension using **Run Extension** (`F5`) inside VS Code.

## Commands

| Command | Title | Keybinding |
|---|---|---|
| `problemExplorer.refresh` | Refresh Problem Decorations | Ctrl+Shift+Alt+P (Cmd+Shift+Alt+P on Mac) |
| `problemExplorer.toggle` | Toggle Problem Decorations | â€” |

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `problemExplorer.enabled` | `boolean` | `true` | Enable or disable problem decorations |
| `problemExplorer.showWarnings` | `boolean` | `true` | Show warning decorations alongside errors |
| `problemExplorer.badgeStyle` | `string` | `letter` | Badge style: `letter` (E/W/I), `count` (problem count), `dot` (colored circle), `none` (color only) |
| `problemExplorer.ignorePatterns` | `string[]` | `["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/target/**", "**/__pycache__/**", "**/vendor/**", "**/.tox/**"]` | Glob patterns for files/folders to ignore |
| `problemExplorer.errorColor` | `string` \| `null` | `null` | Custom CSS color override for errors (e.g. `"#ff0000"`) |
| `problemExplorer.warningColor` | `string` \| `null` | `null` | Custom CSS color override for warnings |
| `problemExplorer.infoColor` | `string` \| `null` | `null` | Custom CSS color override for info diagnostics |

### Auto-Scan

| Setting | Type | Default | Description |
|---|---|---|---|
| `problemExplorer.autoScan.enabled` | `boolean` | `true` | Enable or disable automatic background scanning on file save |
| `problemExplorer.autoScanDelay` | `number` | `2000` | Delay in ms before triggering auto-scan after file changes (min 500) |

Auto-scan runs the configured language tool (TypeScript `tsc --noEmit`, ESLint, etc.) when you save a file. Results appear in the Explorer within seconds.

**Behavior:**
- Triggered by `onDidSaveTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`
- Debounced by `autoScanDelay` (default 2s) to batch rapid saves
- Only the provider owning the file's extension runs (e.g., `.ts` â†’ TypeScript, `.js` â†’ ESLint)
- Status bar shows `$(sync~spin) Scanning...` while a scan is in progress
- Diagnostics update automatically in the Explorer and Status Bar

### Theme Colors

You can also customize colors via `workbench.colorCustomizations` in `settings.json`:

```jsonc
"workbench.colorCustomizations": {
  "problemExplorer.errorForeground": "#ff0000",
  "problemExplorer.warningForeground": "#ffaa00",
  "problemExplorer.infoForeground": "#00aaff"
}
```

## Requirements


## Supported Platforms for Oxlint

The Oxlint diagnostic provider bundles native bindings for the following desktop platforms:

- Windows: x64, arm64
- macOS: x64 (Intel), arm64 (Apple Silicon)
- Linux: x64 (glibc), x64 (musl), arm64 (gnu), arm64 (musl)

These bindings are included in the VSIX, so users do not need to install Oxlint separately.

- VS Code 1.90.0 or higher

## Known Limitations

- Badges are text-only (E, W, I, count, or dot). VS Code's `FileDecorationProvider` API does not support custom icons or background colors.
- Folder color propagation requires an explicit `onDidChangeFileDecorations` event per ancestor â€” handled automatically by the extension.

## Architecture

See [docs/phase-0-task-0-architecture.md](docs/phase-0-task-0-architecture.md) for the full architecture document, including:

- Module overview diagram
- Data flow (activation, runtime changes, folder expansion, configuration)
- Performance strategy (LRU cache, debouncing, synchronous `provideFileDecoration`)
- Risk analysis and edge case handling


## Supported Platforms for Oxlint

The Oxlint diagnostic provider bundles native bindings for the following desktop platforms:

- Windows: x64, arm64
- macOS: x64 (Intel), arm64 (Apple Silicon)
- Linux: x64 (glibc), x64 (musl), arm64 (gnu), arm64 (musl)

These bindings are included in the VSIX, so users do not need to install Oxlint separately.

## Contributing

Contributions, bug reports, and feature requests are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Before submitting, ensure:

- `npm run lint` passes
- `npm run build` succeeds
- Tests pass (`npm test`)

## License

MIT
