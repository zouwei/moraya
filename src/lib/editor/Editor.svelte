<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Editor } from '@milkdown/core';
  import { createEditor } from './setup';
  import { editorStore } from '../stores/editor-store';

  let editorEl: HTMLDivElement;
  let editor: Editor | null = null;

  // Props
  let {
    content = $bindable(''),
  }: {
    content?: string;
  } = $props();

  let isReady = $state(false);

  onMount(async () => {
    editor = await createEditor({
      root: editorEl,
      defaultValue: content,
      onChange: (markdown) => {
        content = markdown;
        editorStore.setDirty(true);
      },
      onFocus: () => {
        editorStore.setFocused(true);
      },
      onBlur: () => {
        editorStore.setFocused(false);
      },
    });
    isReady = true;
  });

  onDestroy(() => {
    if (editor) {
      editor.destroy();
    }
  });
</script>

<div class="editor-wrapper" class:ready={isReady}>
  <div bind:this={editorEl} class="editor-root"></div>
</div>

<style>
  .editor-wrapper {
    flex: 1;
    overflow-y: auto;
    padding: 2rem 3rem;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .editor-wrapper.ready {
    opacity: 1;
  }

  .editor-root {
    max-width: 800px;
    margin: 0 auto;
    min-height: 100%;
  }
</style>
