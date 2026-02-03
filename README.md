# Moraya

A minimal, open-source WYSIWYG Markdown editor built with Rust + Tauri v2. Inspired by Typora's seamless editing experience — small (~3MB DMG), elegant, and AI-ready.

> **mora** (Latin, "a moment") + **ya** (Chinese, "elegance") = **Moraya** (墨雅)

## Features

- **Typora-style WYSIWYG** — type `# ` and it renders as a heading instantly, powered by [Milkdown](https://milkdown.dev/) (ProseMirror-based)
- **Three editor modes** — Visual, Source (raw Markdown), and Split (side-by-side with scroll sync). Toggle with `Cmd+/` and `Cmd+Shift+/`
- **Math support** — inline and block LaTeX via KaTeX
- **GFM** — tables (with floating toolbar), strikethrough, task lists, and more
- **AI integration** — multi-provider LLM chat panel supporting Claude, OpenAI, Gemini, DeepSeek, Ollama, and custom OpenAI-compatible endpoints with streaming
- **MCP protocol** — stdio, SSE, and HTTP transports for Model Context Protocol servers
- **i18n** — English and Simplified Chinese, with system locale auto-detection
- **Native menu & shortcuts** — Typora-style keyboard bindings with full native macOS/Windows/Linux menu (File, Edit, Paragraph, Format, View, Help)
- **Dark / Light themes** — auto-follows system preference or manual toggle via CSS custom properties
- **Frameless window** — custom title bar with macOS traffic light integration
- **Tiny footprint** — DMG ~2.8MB, binary ~4.6MB, app bundle ~4.7MB
- **Export** — HTML and LaTeX built-in; PDF, DOCX, EPUB planned (pandoc integration)

## Architecture

```
┌───────────────────────────────────────┐
│         Tauri WebView (Frontend)      │
│   Svelte 5 + Milkdown + TypeScript   │
│                                       │
│  ┌──────────┐ ┌───────┐ ┌──────────┐ │
│  │  Editor   │ │  AI   │ │ Settings │ │
│  │(Milkdown) │ │ Panel │ │  Panel   │ │
│  │ + Source  │ │       │ │ (tabbed) │ │
│  └─────┬─────┘ └──┬────┘ └────┬─────┘ │
│        │          │            │       │
│  ┌─────┴──────────┴────────────┴─────┐ │
│  │       Services & Stores           │ │
│  │  (file, AI, MCP, settings, i18n)  │ │
│  └───────────────┬───────────────────┘ │
│                  │ Tauri IPC (invoke)  │
└──────────────────┼─────────────────────┘
                   │
┌──────────────────┼─────────────────────┐
│         Rust Backend (Tauri)           │
│                                        │
│  ┌────────────┐ ┌──────────┐ ┌──────┐ │
│  │ File I/O   │ │ MCP Proc │ │ Menu │ │
│  │ Commands   │ │ Manager  │ │      │ │
│  └────────────┘ └──────────┘ └──────┘ │
└────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Tauri v2 | >=2.9,<2.10 |
| Backend | Rust | 2021 edition |
| Frontend | Svelte 5 + SvelteKit (SPA via adapter-static) | ^5.0.0 / ^2.9.0 |
| Editor Engine | Milkdown v7 (ProseMirror-based) | ^7.18.0 |
| Math Rendering | KaTeX | ^0.16.28 |
| Build Tool | Vite | ^6.0.3 |
| Package Manager | pnpm | 10.x |
| Language | TypeScript (strict mode) | ~5.6.2 |

## Getting Started

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Node.js](https://nodejs.org/) (>=18)
- [pnpm](https://pnpm.io/) (v10.x)
- Tauri v2 system dependencies — see [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
# Install dependencies
pnpm install

# Start dev server with hot reload
pnpm tauri dev

# Frontend only (no Tauri shell)
pnpm dev
```

### Build

```bash
# Full production build (frontend + Rust + bundle)
pnpm tauri build

# Type checking
pnpm check

# Rust only
cd src-tauri && cargo check
```

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| New | `Cmd+N` | `Ctrl+N` |
| Open | `Cmd+O` | `Ctrl+O` |
| Save | `Cmd+S` | `Ctrl+S` |
| Save As | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Settings | `Cmd+,` | `Ctrl+,` |
| Toggle Visual/Source | `Cmd+/` | `Ctrl+/` |
| Toggle Split Mode | `Cmd+Shift+/` | `Ctrl+Shift+/` |
| Toggle Sidebar | `Cmd+\` | `Ctrl+\` |
| Toggle AI Panel | `Cmd+Shift+I` | `Ctrl+Shift+I` |
| Export HTML | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| Heading 1–6 | `Cmd+1`–`6` | `Ctrl+1`–`6` |
| Bold | `Cmd+B` | `Ctrl+B` |
| Italic | `Cmd+I` | `Ctrl+I` |
| Inline Code | `Cmd+E` | `Ctrl+E` |
| Link | `Cmd+K` | `Ctrl+K` |
| Zoom In/Out/Reset | `Cmd+=` / `Cmd+-` / `Cmd+0` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

## Project Structure

```
moraya/
├── src-tauri/                    # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── main.rs               # Entry point
│   │   ├── lib.rs                # App setup, plugins, menu events
│   │   ├── menu.rs               # Native menu definition
│   │   └── commands/
│   │       ├── mod.rs            # Module declarations
│   │       └── file.rs           # File I/O (read, write, read_dir_recursive)
│   ├── tauri.conf.json           # Window config, CSP, bundle settings
│   └── capabilities/default.json # Permission scopes
│
├── src/                          # Frontend (Svelte 5 + TypeScript)
│   ├── routes/
│   │   └── +page.svelte          # Main page (layout, menu handlers, scroll sync)
│   └── lib/
│       ├── editor/
│       │   ├── Editor.svelte     # Milkdown WYSIWYG editor
│       │   ├── SourceEditor.svelte # Raw Markdown editor (source mode)
│       │   ├── TableToolbar.svelte # Floating table operations toolbar
│       │   ├── setup.ts          # Milkdown initialization
│       │   └── plugins/
│       │       └── keybindings.ts # Typora-style shortcuts
│       ├── components/
│       │   ├── TitleBar.svelte   # Custom frameless title bar
│       │   ├── StatusBar.svelte  # Word/char count, mode indicator
│       │   ├── Sidebar.svelte    # File explorer tree
│       │   ├── SettingsPanel.svelte # Tabbed settings
│       │   └── ai/              # AI chat panel, settings, MCP panel
│       ├── services/
│       │   ├── file-service.ts   # File operations via Tauri IPC
│       │   ├── export-service.ts # Export to HTML, LaTeX
│       │   ├── ai/              # Multi-provider LLM adapters & orchestration
│       │   └── mcp/             # MCP client (SSE, HTTP, stdio)
│       ├── stores/              # Editor, settings, file tree state
│       ├── i18n/                # i18n engine with en & zh-CN locales
│       └── styles/              # CSS variables, themes, editor styles
│
└── static/                       # Static assets (favicon, logos)
```

## Development Roadmap

- [x] **Phase 1** — Core Editor: WYSIWYG Markdown editing, math, file ops, sidebar, settings, export, themes
- [x] **Phase 2** — AI Integration: Multi-provider LLM API, streaming, chat panel, AI commands
- [x] **Phase 3** — MCP Ecosystem: MCP client (3 transports), server management
- [x] **Phase 4** — Editor Enhancement: Source/Visual/Split modes, table toolbar, native menu, i18n, scroll sync
- [ ] **Phase 5** — Polish & Ecosystem: advanced export (pandoc), plugin system, performance optimization

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## License

[Apache License 2.0](LICENSE)
