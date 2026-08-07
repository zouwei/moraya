/**
 * @vitest-environment happy-dom
 *
 * ThinkingOrb wiring (desktop). Mirrors moraya-web's thinking-orb.test.ts.
 *
 * The orb engine draws to a canvas and starts a requestAnimationFrame loop, so
 * the two things that matter here are lifecycle, not pixels: the engine must
 * not mount after the component is already gone (the import is awaited, so that
 * window is real), and it must be torn down on destroy or the animation loop
 * outlives the chat panel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const destroy = vi.fn();
const updateOptions = vi.fn();
let mountCalls: Array<{ container: unknown; options: Record<string, unknown> }> = [];

vi.mock('thinking-orbs-universal', () => ({
  mountOrb: (container: unknown, options: Record<string, unknown>) => {
    mountCalls.push({ container, options });
    return { controller: {}, canvas: document.createElement('canvas'), updateOptions, destroy };
  },
}));

beforeEach(() => {
  mountCalls = [];
  destroy.mockClear();
  updateOptions.mockClear();
});

/**
 * Mirrors ThinkingOrb's onMount body. Testing the real component would need a
 * Svelte client-side mount harness this repo does not have; the lifecycle logic
 * is the part with a failure mode, so it is exercised directly.
 */
function runOrbLifecycle(host: HTMLElement | null, opts: Record<string, unknown>) {
  let disposed = false;
  let orb: { destroy: () => void } | null = null;
  const started = (async () => {
    const { mountOrb } = await import('thinking-orbs-universal');
    if (disposed || !host) return;
    orb = mountOrb(host, opts) as unknown as { destroy: () => void };
  })();
  return {
    started,
    cleanup() {
      disposed = true;
      orb?.destroy();
      orb = null;
    },
  };
}

describe('ThinkingOrb lifecycle', () => {
  it('mounts the engine onto the host with the requested state', async () => {
    const host = document.createElement('span');
    const h = runOrbLifecycle(host, { state: 'composing', size: 20, theme: 'auto' });
    await h.started;

    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]?.container).toBe(host);
    expect(mountCalls[0]?.options.state).toBe('composing');
    expect(mountCalls[0]?.options.size).toBe(20);
  });

  it('destroys the engine on cleanup so the rAF loop does not outlive the panel', async () => {
    const h = runOrbLifecycle(document.createElement('span'), { state: 'composing', size: 20 });
    await h.started;
    h.cleanup();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does NOT mount when the component was destroyed during the dynamic import', async () => {
    // The import is awaited; without the `disposed` guard this leaks a canvas
    // and an animation loop with no component left to stop it.
    const h = runOrbLifecycle(document.createElement('span'), { state: 'composing', size: 20 });
    h.cleanup();
    await h.started;

    expect(mountCalls).toHaveLength(0);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('does not mount without a host element', async () => {
    const h = runOrbLifecycle(null, { state: 'composing', size: 20 });
    await h.started;

    expect(mountCalls).toHaveLength(0);
  });
});
