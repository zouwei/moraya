<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { settingsStore } from '../stores/settings-store';
  import { editorStore } from '../stores/editor-store';

  let {
    content = $bindable(''),
    hideScrollbar = false,
  }: {
    content?: string;
    hideScrollbar?: boolean;
  } = $props();

  let showLineNumbers = $state(false);
  let tabSize = $state(4);
  let editorLineWidth = $state(800);
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  settingsStore.subscribe(state => {
    showLineNumbers = state.showLineNumbers;
    tabSize = state.editorTabSize;
    editorLineWidth = state.editorLineWidth;
  });

  let lineCount = $derived(content.split('\n').length);

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = textareaEl.scrollHeight + 'px';
  }

  function handleInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    content = textarea.value;
    editorStore.setDirty(true);
    editorStore.setContent(content);
    autoResize();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      event.preventDefault();
      const textarea = event.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const spaces = ' '.repeat(tabSize);
      content = content.substring(0, start) + spaces + content.substring(end);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + tabSize;
      });
    }
  }

  // Auto-resize when content changes externally (e.g. split mode sync)
  $effect(() => {
    content;
    tick().then(autoResize);
  });

  onMount(() => {
    autoResize();
  });
</script>

<div class="source-editor-outer" class:hide-scrollbar={hideScrollbar}>
  <div class="source-editor-inner" style="max-width: {editorLineWidth}px">
    {#if showLineNumbers}
      <div class="line-numbers">
        {#each Array(lineCount) as _, i}
          <span class="line-number">{i + 1}</span>
        {/each}
      </div>
    {/if}
    <textarea
      bind:this={textareaEl}
      class="source-textarea"
      value={content}
      oninput={handleInput}
      onkeydown={handleKeydown}
      spellcheck="true"
      style="tab-size: {tabSize}"
    ></textarea>
  </div>
</div>

<style>
  .source-editor-outer {
    flex: 1;
    overflow-y: auto;
    padding: 2rem 3rem;
    background: var(--bg-primary);
  }

  .source-editor-outer.hide-scrollbar {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .source-editor-outer.hide-scrollbar::-webkit-scrollbar {
    display: none;
  }

  .source-editor-inner {
    margin: 0 auto;
    min-height: 100%;
    display: flex;
  }

  .line-numbers {
    display: flex;
    flex-direction: column;
    padding: 0 0.75rem 0 0;
    text-align: right;
    user-select: none;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: var(--font-size-sm);
    line-height: 1.6;
    color: var(--text-muted);
    border-right: 1px solid var(--border-light);
    margin-right: 0.75rem;
  }

  .line-number {
    display: block;
    min-width: 2rem;
  }

  .source-textarea {
    flex: 1;
    resize: none;
    border: none;
    outline: none;
    padding: 0;
    background: transparent;
    color: var(--text-primary);
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: var(--font-size-sm);
    line-height: 1.6;
    overflow: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .source-textarea::placeholder {
    color: var(--text-muted);
  }
</style>
