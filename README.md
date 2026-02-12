# Moraya — The Local AI-Era Minimalist Markdown Editor

**Moraya** is a free, open-source, ultra-lightweight (~5MB) WYSIWYG Markdown editor built with Rust + Tauri v2. Inspired by minimalist seamless editing, it delivers an elegant writing experience while integrating **the most advanced local AI ecosystem and MCP (Model Context Protocol) capabilities** — turning your editor into a powerful, privacy-first AI agent platform.

> **mora** (Latin: "a moment") + **ya** (Chinese: "elegance") = **Moraya**\
> Privacy-first • Fully local • Infinitely extensible AI

![Visual Editor](https://raw.githubusercontent.com/zouwei/resource/master/images/moraya/20260208-143332.-image.png)
![AI Chat Panel](https://raw.githubusercontent.com/zouwei/resource/master/images/moraya/20260208-143226.-image.png)
![AI Image Generation](https://raw.githubusercontent.com/zouwei/resource/master/images/moraya/20260208-143342.-image.png)
![MCP Marketplace](https://raw.githubusercontent.com/zouwei/resource/master/images/moraya/20260208-143349.-image.png)

## Why Moraya? Key Advantages

* **Ultra-Lightweight & Native Performance** — \~5MB installer, instant launch, tiny memory footprint.

* **True Instant WYSIWYG** — Type `# `    and see a heading instantly (Milkdown/ProseMirror-powered).

* **Most Powerful Local AI Integration** — Multi-provider streaming chat (Claude, OpenAI, Gemini, DeepSeek, Ollama, custom endpoints) with smart commands and AI image generation.

* **Leading MCP Ecosystem** — Dynamic MCP container, one-click Marketplace (Official, LobeHub, Smithery), autonomous local AI services, tool calling, and custom agent workflows — all fully self-hosted.

* **Complete Modern Workflow** — Visual/Source/Split modes, publishing tools, SEO assistant, AI images, and automatic RSS feeds.

* **Privacy by Design** — Everything can run offline with local models; your data never leaves your machine.

## Features

* **Three Editor Modes** — Visual (WYSIWYG), Source (raw Markdown), Split (synced side-by-side). Toggle with `Cmd+/` or `Ctrl+/`.

* **Full Math Support** — Inline and block LaTeX via KaTeX.

* **GFM Extensions** — Tables with floating toolbar, task lists, strikethrough, and more.

* **AI-Powered Writing** — Streaming chat panel, quick commands (`/write`, `/continue`, `/summarize`, etc.), insert/replace/copy actions.

* **MCP Protocol** — stdio/SSE/HTTP transports, dynamic container, marketplace browsing, one-click server installation.

* **Internationalization** — English & Simplified Chinese (auto-detect).

* **Native Menus & Shortcuts** — Full macOS/Windows/Linux menus and minimalist keyboard bindings, soon iPados.

* **Themes** — Light/Dark with system sync.

  * **Export** — HTML & LaTeX built-in; PDF/DOCX/IMAGE.

* **Frameless Window** — Custom title bar with native traffic lights.

## Architecture Overview

```
┌────────────────────────────────────────┐
│         Tauri WebView (Frontend)       │
│   Svelte 5 + Milkdown + TypeScript     │
│                                        │
│  ┌───────────┐ ┌───────┐ ┌──────────┐  │
│  │  Editor   │ │  AI   │ │ Settings │  │
│  │(Milkdown) │ │ Panel │ │  Panel   │  │
│  │ + Source  │ │       │ │ (tabbed) │  │
│  └─────┬─────┘ └──┬────┘ └────┬─────┘  │
│        │          │           │        │
│  ┌─────┴──────────┴───────────┴──────┐ │
│  │       Services & Stores           │ │
│  │  (file, AI, MCP, settings, i18n)  │ │
│  └───────────────┬───────────────────┘ │
│                  │ Tauri IPC (invoke)  │
└──────────────────┼─────────────────────┘
                   │
┌──────────────────┼─────────────────────┐
│         Rust Backend (Tauri)           │
│                                        │
│  ┌────────────┐ ┌──────────┐ ┌──────┐  │
│  │ File I/O   │ │ MCP Proc │ │ Menu │  │
│  │ Commands   │ │ Manager  │ │      │  │
│  └────────────┘ └──────────┘ └──────┘  │
└────────────────────────────────────────┘
```

## Tech Stack

| Layer           | Technology                                    | Version         |
| --------------- | --------------------------------------------- | --------------- |
| Runtime         | Tauri v2                                      | >=2.9,<2.10     |
| Backend         | Rust                                          | 2021 edition    |
| Frontend        | Svelte 5 + SvelteKit (SPA via adapter-static) | ^5.0.0 / ^2.9.0 |
| Editor Engine   | Milkdown v7 (ProseMirror-based)               | ^7.18.0         |
| Math Rendering  | KaTeX                                         | ^0.16.28        |
| Build Tool      | Vite                                          | ^6.0.3          |
| Package Manager | pnpm                                          | 10.x            |
| Language        | TypeScript (strict mode)                      | \~5.6.2         |

## Install

Download the latest release from [GitHub Releases](https://github.com/nicepkg/moraya/releases).

> **macOS note**: The app is not code-signed. If you see *"Moraya is damaged and can't be opened"*, run this in Terminal:
>
> ```bash
> xattr -cr /Applications/Moraya.app
> ```
>
> Then open the app again.

## Getting Started

### Prerequisites

* [Rust](https://www.rust-lang.org/tools/install) (stable)

* [Node.js](https://nodejs.org/) (>=18)

* [pnpm](https://pnpm.io/) (v10.x)

* Tauri v2 system dependencies — see [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

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

| Action               | macOS           | Windows/Linux    |
| -------------------- | --------------- | ---------------- |
| New                  | `Cmd+N`         | `Ctrl+N`         |
| New Window           | `Cmd+Shift+N`   | `Ctrl+Shift+N`   |
| Open                 | `Cmd+O`         | `Ctrl+O`         |
| Save                 | `Cmd+S`         | `Ctrl+S`         |
| Save As              | `Cmd+Shift+S`   | `Ctrl+Shift+S`   |
| Settings             | `Cmd+,`         | `Ctrl+,`         |
| Find                 | `Cmd+F`         | `Ctrl+F`         |
| Replace              | `Cmd+H`         | `Ctrl+H`         |
| Toggle Visual/Source | `Cmd+/`         | `Ctrl+/`         |
| Toggle Split Mode    | `Cmd+Shift+/`   | `Ctrl+Shift+/`   |
| Toggle Sidebar       | `Cmd+\`         | `Ctrl+\`         |
| Toggle AI Panel      | `Cmd+J`         | `Ctrl+J`         |
| Export HTML          | `Cmd+Shift+E`   | `Ctrl+Shift+E`   |
| Heading 1–6          | `Cmd+1`–`6`     | `Ctrl+1`–`6`     |
| Bold                 | `Cmd+B`         | `Ctrl+B`         |
| Italic               | `Cmd+I`         | `Ctrl+I`         |
| Strikethrough        | `Cmd+Shift+X`   | `Ctrl+Shift+X`   |
| Inline Code          | `Cmd+E`         | `Ctrl+E`         |
| Link                 | `Cmd+K`         | `Ctrl+K`         |
| Insert Image         | `Cmd+Shift+G`   | `Ctrl+Shift+G`   |
| Code Block           | `Cmd+Shift+K`   | `Ctrl+Shift+K`   |
| Quote                | `Cmd+Shift+Q`   | `Ctrl+Shift+Q`   |
| Zoom In/Out/Reset    | `Cmd+=`/`-`/`0` | `Ctrl+=`/`-`/`0` |

## AI Assisted Writing

Moraya has built-in AI-powered writing assistance with multi-provider support and streaming responses.

### Configuration

1. Open Settings (`Cmd+,` / `Ctrl+,`)
2. Select the **AI** tab
3. Choose a provider and fill in the required fields:

| Provider         | API Key Required | Notes                                  |
| ---------------- | ---------------- | -------------------------------------- |
| Anthropic Claude | Yes              | claude-opus-4.5, claude-sonnet-4, etc. |
| OpenAI           | Yes              | gpt-4o, gpt-4o-mini, o1, etc.          |
| Google Gemini    | Yes              | gemini-2.0-flash, gemini-1.5-pro       |
| DeepSeek         | Yes              | deepseek-chat, deepseek-reasoner       |
| Ollama (Local)   | No               | Requires Ollama running locally        |
| Custom API       | Optional         | Any OpenAI-compatible endpoint         |

1. Click **Test Connection** to verify the configuration
2. Adjust Max Tokens and Temperature as needed

### Usage

**Open the AI panel** with `Cmd+J` (`Ctrl+J` on Windows/Linux), or via the menu View → Toggle AI Panel. A 340px chat sidebar will appear on the right.

**Free-form chat** — Type any question in the input box and press `Enter`. AI responds in real-time with streaming output.

**Quick commands** — Type `/` in the input box to open the command palette:

| Command        | Description                                | Requires Selection |
| -------------- | ------------------------------------------ | ------------------ |
| `/write`       | Generate content from a prompt             | No                 |
| `/continue`    | Continue writing from the current document | No                 |
| `/outline`     | Generate an article outline                | No                 |
| `/summarize`   | Summarize selected text                    | Yes                |
| `/translate`   | Translate between Chinese and English      | Yes                |
| `/improve`     | Improve writing quality                    | Yes                |
| `/fix-grammar` | Fix grammar and spelling errors            | Yes                |
| `/simplify`    | Simplify complex text                      | Yes                |
| `/expand`      | Expand on a topic with more details        | Yes                |
| `/explain`     | Explain selected text                      | Yes                |

### Applying AI Results

Each AI response has action buttons below it:

* **Insert into editor** — Append the AI response to the end of the document

* **Replace selection** — Replace the currently selected text with the AI response

* **Copy** — Copy the response to the clipboard

## Development Roadmap

* [x] **v0.1.0** — Core Platform: WYSIWYG editor (Milkdown), math rendering (KaTeX), multi-provider AI chat (Claude/OpenAI/Gemini/DeepSeek/Ollama), MCP client (stdio/SSE/HTTP), Source/Visual/Split modes, native menu, i18n → [Detailed Requirements](docs/iterations/v0.1.0-core-platform.md)

* [x] **v0.2.0** — Publish Workflow: SEO assistant, AI image generation, multi-target publishing → [Detailed Requirements](docs/iterations/v0.2.0-publish-workflow.md)

* [x] **v0.3.0** — MCP Ecosystem Enhancement: AI tool calling, stdio UI, presets, knowledge sync, conversational MCP config, editor content sync, multi-model management → [Detailed Requirements](docs/iterations/v0.3.0-mcp-ecosystem.md)

* [x] **v0.3.1** — MCP Marketplace: Multi-source registry browsing, one-click install with auto-config, 3 data sources (Official, LobeHub, Smithery) → [Detailed Requirements](docs/iterations/v0.3.1-mcp-marketplace.md)

* [x] **v0.4.0** — Dynamic MCP Container: AI-driven dynamic MCP service creation, lightweight Node.js runtime, 4 internal AI tools, hybrid lifecycle management → [Detailed Requirements](docs/iterations/v0.4.0-mcp-container.md)

* [x] **v0.5.0** — RSS Feed: Auto-update RSS feed when publishing articles, per-target RSS config, zero-dependency XML generation → [Detailed Requirements](docs/iterations/v0.5.0-rss-feed.md)

* [x] **v0.6.0** — Security Hardening: API Key Keychain storage, AI proxy in Rust backend, CSP tightening, MCP security hardening, path traversal protection, HTML export sanitization, error sanitization, unsafe FFI hardening → [Detailed Requirements](docs/iterations/v0.6.0-security-hardening.md)

* [ ] **v0.7.0** — iPadOS Adaptation: Tab bar system for multi-file editing, floating touch toolbar, virtual keyboard handling, platform detection, touch interaction adaptations, MCP SSE/HTTP only (stdio disabled), CI/CD with TestFlight → [Detailed Requirements](docs/iterations/v0.7.0-ipados-adaptation.md)

* [ ] **v0.8.0** — iPhone Adaptation: Drawer navigation (sidebar replacement), BottomSheet (AI panel/Settings), Split mode narrow-screen disable, universal IPA build (iPad + iPhone), unified Apple signing & App Store Connect CI/CD → [Detailed Requirements](docs/iterations/v0.8.0-iphone-adaptation.md)

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## License

[Apache License 2.0](LICENSE)

<mark>
