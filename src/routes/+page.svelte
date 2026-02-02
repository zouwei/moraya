<script lang="ts">
  import { onMount } from 'svelte';
  import Editor from '$lib/editor/Editor.svelte';
  import TitleBar from '$lib/components/TitleBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import SettingsPanel from '$lib/components/SettingsPanel.svelte';
  import { editorStore } from '$lib/stores/editor-store';
  import { settingsStore } from '$lib/stores/settings-store';
  import { openFile, saveFile, saveFileAs, loadFile, getFileNameFromPath } from '$lib/services/file-service';
  import { exportDocument, type ExportFormat } from '$lib/services/export-service';

  import '$lib/styles/global.css';
  import '$lib/styles/editor.css';

  const defaultContent = `# Welcome to Inkra

A minimal, AI-ready Markdown editor.

## Features

- **WYSIWYG** Markdown editing
- Math formula support: $E = mc^2$
- Dark & Light themes
- Lightweight (~5MB)

## Math Example

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## Code Example

\`\`\`javascript
const greeting = "Hello, Inkra!";
console.log(greeting);
\`\`\`

## Table Example

| Feature | Status |
|---------|--------|
| Markdown | Done |
| Math | Done |
| AI Integration | Planned |

---

Start writing your ideas here...
`;

  let content = $state(defaultContent);
  let showSidebar = $state(false);
  let showSettings = $state(false);
  let currentFileName = $state('Untitled');

  settingsStore.subscribe(state => {
    showSidebar = state.showSidebar;
  });

  editorStore.subscribe(state => {
    if (state.currentFilePath) {
      currentFileName = getFileNameFromPath(state.currentFilePath);
    } else {
      currentFileName = 'Untitled';
    }
  });

  // Auto-save timer
  let autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  function setupAutoSave() {
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    const settings = settingsStore.getState();
    if (settings.autoSave) {
      autoSaveTimer = setInterval(() => {
        const editorState = editorStore.getState();
        if (editorState.isDirty && editorState.currentFilePath) {
          saveFile(content);
        }
      }, settings.autoSaveInterval);
    }
  }

  // Typora-style keyboard shortcuts
  function handleKeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;

    // File shortcuts
    if (mod && event.key === 's') {
      event.preventDefault();
      if (event.shiftKey) {
        saveFileAs(content);
      } else {
        saveFile(content);
      }
      return;
    }

    if (mod && event.key === 'o') {
      event.preventDefault();
      handleOpenFile();
      return;
    }

    if (mod && event.key === 'n') {
      event.preventDefault();
      handleNewFile();
      return;
    }

    // View shortcuts
    if (mod && event.key === '\\') {
      event.preventDefault();
      settingsStore.toggleSidebar();
      return;
    }

    if (mod && event.key === ',') {
      event.preventDefault();
      showSettings = !showSettings;
      return;
    }

    // Export shortcut
    if (mod && event.shiftKey && event.key === 'E') {
      event.preventDefault();
      exportDocument(content, 'html');
      return;
    }

    // Zoom
    if (mod && event.key === '=') {
      event.preventDefault();
      const settings = settingsStore.getState();
      settingsStore.update({ fontSize: Math.min(settings.fontSize + 1, 24) });
      document.documentElement.style.setProperty('--font-size-base', `${settings.fontSize + 1}px`);
      return;
    }

    if (mod && event.key === '-' && !event.shiftKey) {
      event.preventDefault();
      const settings = settingsStore.getState();
      settingsStore.update({ fontSize: Math.max(settings.fontSize - 1, 12) });
      document.documentElement.style.setProperty('--font-size-base', `${settings.fontSize - 1}px`);
      return;
    }
  }

  async function handleOpenFile() {
    const fileContent = await openFile();
    if (fileContent !== null) {
      content = fileContent;
    }
  }

  function handleNewFile() {
    content = '';
    editorStore.reset();
  }

  async function handleFileSelect(path: string) {
    const fileContent = await loadFile(path);
    content = fileContent;
  }

  onMount(() => {
    // Detect platform for CSS classes
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac')) {
      document.body.classList.add('platform-macos');
    } else if (ua.includes('win')) {
      document.body.classList.add('platform-windows');
    } else {
      document.body.classList.add('platform-linux');
    }

    setupAutoSave();

    return () => {
      if (autoSaveTimer) clearInterval(autoSaveTimer);
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app-container">
  <TitleBar title={currentFileName} />

  <div class="app-body">
    {#if showSidebar}
      <Sidebar onFileSelect={handleFileSelect} />
    {/if}

    <main class="editor-area">
      <Editor bind:content />
    </main>
  </div>

  <StatusBar />
</div>

{#if showSettings}
  <SettingsPanel onClose={() => showSettings = false} />
{/if}

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .app-body {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-primary);
  }
</style>
