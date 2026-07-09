# Problem-Explorer-vs-code-extension-
# Problem Explorer

> **Stop hunting for broken files.**
>
> Problem Explorer automatically highlights files and folders containing **errors** or **warnings** directly in the VS Code Explorer, making project-wide issues visible at a glance.

## ✨ Features

* 🔴 Highlight files with errors.
* 🟡 Highlight files with warnings.
* 📁 Propagate problem status to parent folders.
* ⚡ Real-time updates as diagnostics change.
* 🌍 Works with **any language** that publishes VS Code diagnostics.
* 🎨 Configurable colors, badges, and behavior.
* 🚀 Lightweight with minimal performance impact.

---

## Why?

When working on large projects, it's easy to lose track of which files contain problems.

The VS Code **Problems** panel lists diagnostics, but the Explorer doesn't provide an immediate overview of where issues are located within your project structure.

Problem Explorer solves this by making diagnostics visible directly in the Explorer.

Instead of this:

```text
packages/
├── core/
├── cli/
└── sdk/
```

You'll see something like:

```text
packages/
├── core 🔴
│   ├── parser.ts 🔴
│   ├── lexer.ts 🟡
│   └── utils.ts
├── cli
└── sdk 🔴
    └── index.ts 🔴
```

You instantly know where to focus.

---

## Supported Languages

Problem Explorer is language-agnostic.

It works with any extension that publishes diagnostics through the VS Code API, including:

* TypeScript
* JavaScript
* Python
* C/C++
* Rust
* Go
* Java
* C#
* PHP
* Lua
* And many more...

If a language server reports diagnostics, Problem Explorer can display them.

---

## Planned Features

* [ ] File decorations for errors and warnings
* [ ] Folder decorations based on child diagnostics
* [ ] Configurable severity colors
* [ ] Problem count badges
* [ ] Ignore configurable folders (e.g. `node_modules`, `dist`, `build`)
* [ ] Refresh command
* [ ] Performance optimizations for large workspaces
* [ ] Multi-root workspace support

---

## Installation

Coming soon on the Visual Studio Marketplace.

For development:

```bash
git clone https://github.com/<your-username>/problem-explorer.git
cd problem-explorer
npm install
```

Launch the extension using **Run Extension** (`F5`) inside VS Code.

---


### Version 0.1

* Basic file decorations
* Automatic refresh
* Error & warning support

### Version 0.2

* Folder decorations
* Custom settings
* Improved performance

### Version 1.0

* Stable API
* Multi-root workspaces
* Extensive testing
* Marketplace release

---

## Contributing

Contributions, bug reports, and feature requests are welcome.

If you discover a limitation in the VS Code API or have ideas for improving diagnostics visualization, feel free to open an issue or submit a pull request.

---

## License

MIT

---

Made for developers who'd rather fix problems than spend five minutes figuring out which file contains them.
