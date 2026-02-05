<script lang="ts">
  let {
    messages = [],
  }: {
    messages?: { id: number; text: string; type: 'success' | 'error' }[];
  } = $props();
</script>

{#if messages.length > 0}
  <div class="toast-container">
    {#each messages as msg (msg.id)}
      <div class="toast" class:success={msg.type === 'success'} class:error={msg.type === 'error'}>
        <span class="toast-icon">{msg.type === 'success' ? '✓' : '✗'}</span>
        <span class="toast-text">{msg.text}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: 40px;
    right: 1rem;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: var(--font-size-sm);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    animation: toastIn 0.2s ease-out;
    pointer-events: auto;
    max-width: 360px;
  }

  .toast.success {
    background: var(--bg-primary);
    border: 1px solid #34d399;
    color: var(--text-primary);
  }

  .toast.error {
    background: var(--bg-primary);
    border: 1px solid #f87171;
    color: var(--text-primary);
  }

  .toast-icon {
    flex-shrink: 0;
    font-weight: 700;
    font-size: var(--font-size-sm);
  }

  .toast.success .toast-icon {
    color: #34d399;
  }

  .toast.error .toast-icon {
    color: #f87171;
  }

  .toast-text {
    line-height: 1.4;
  }

  @keyframes toastIn {
    from { transform: translateX(20px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
