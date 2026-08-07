<!--
  ThinkingOrb — Svelte wrapper around `thinking-orbs-universal`.
  Kept in step with moraya-web's src/lib/components/ThinkingOrb.svelte.

  The upstream `thinking-orbs` package is React-only (react + react-dom are
  required peers), so it cannot be used here. `thinking-orbs-universal` is the
  framework-agnostic port of the same design: a plain
  `mountOrb(container, options)` drawing to a canvas with no framework
  attached. React and Vue are OPTIONAL peers there, so nothing extra installs.

  The engine is dynamically imported — ~21 KB of canvas code that is only
  needed once a response is actually streaming.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { MountedOrbInstance, OrbState, OrbSize, OrbTheme } from 'thinking-orbs-universal';

  let {
    // NOT named `state`: a local binding by that name makes Svelte parse the
    // `$state` rune below as a `$store` subscription of it, which fails to
    // compile ("Cannot use 'state' as a store").
    orbState = 'composing',
    size = 20,
    theme = 'auto',
    ariaLabel,
  }: {
    /** Which tuned animation to run. */
    orbState?: OrbState;
    /** Only 20 (inline) and 64 (avatar) are tuned presets upstream. */
    size?: OrbSize;
    /**
     * Which palette to draw with — it describes the SUBSTRATE, not the app's
     * theme. The engine mirrors its ink on a dark substrate (`1 - white`) so
     * near dots read bright instead of black. Pin `'dark'` whenever the orb
     * sits on a saturated or dark fill; `'auto'` follows the surrounding app
     * theme and is right on ordinary backgrounds.
     */
    theme?: OrbTheme;
    /**
     * Accessible name. When omitted the canvas is hidden from assistive tech —
     * correct when the orb sits inside a button that already has its own label,
     * which would otherwise be announced twice.
     */
    ariaLabel?: string;
  } = $props();

  let host = $state<HTMLSpanElement | undefined>();
  let orb = $state<MountedOrbInstance | null>(null);

  onMount(() => {
    let disposed = false;
    void (async () => {
      const { mountOrb } = await import('thinking-orbs-universal');
      // The await means this component can be destroyed before the engine
      // lands; mounting then would leak a canvas and an animation frame loop.
      if (disposed || !host) return;
      orb = mountOrb(host, { state: orbState, size, theme, ariaLabel });
    })();
    return () => {
      disposed = true;
      orb?.destroy();
      orb = null;
    };
  });

  // `orb` is $state so this re-runs once the dynamic import resolves, not only
  // when the props change — otherwise a state change during the import window
  // would be silently dropped.
  $effect(() => {
    orb?.updateOptions({ state: orbState, size, theme });
  });
</script>

<span
  class="thinking-orb"
  style="--orb-size: {size}px"
  bind:this={host}
  aria-hidden={ariaLabel ? undefined : 'true'}
></span>

<style>
  .thinking-orb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--orb-size);
    height: var(--orb-size);
    line-height: 0;
  }
  .thinking-orb :global(canvas) {
    display: block;
    width: var(--orb-size);
    height: var(--orb-size);
  }
</style>
