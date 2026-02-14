/**
 * Mermaid renderer — lazy-loads mermaid library and provides render API.
 *
 * This is a utility module imported on-demand by code-block-view.ts,
 * NOT a Milkdown plugin. The mermaid library (~2.4 MB) is loaded only
 * when the first mermaid code block is encountered.
 *
 * IMPORTANT: mermaid.render() manipulates global DOM state and is NOT safe
 * to call concurrently. All renders go through a serial queue.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidModule: any = null;
let loadingPromise: Promise<void> | null = null;
let renderCounter = 0;

// ── Serial render queue ──────────────────────────
// Mermaid.render() creates a temp SVG in the DOM, measures text, then removes
// it. If two renders overlap, the second corrupts the first's temp element,
// causing "Render failed". This queue ensures only one render runs at a time.
let renderQueue: Promise<void> = Promise.resolve();

function isDark(): boolean {
  const dt = document.documentElement.getAttribute('data-theme');
  if (dt === 'dark') return true;
  if (dt === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Read resolved CSS custom property values from :root */
function resolveThemeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    primaryColor: s.getPropertyValue('--accent-color').trim() || '#4a90d9',
    primaryTextColor: s.getPropertyValue('--text-primary').trim() || '#333',
    primaryBorderColor: s.getPropertyValue('--border-color').trim() || '#ccc',
    lineColor: s.getPropertyValue('--text-secondary').trim() || '#666',
    secondaryColor: s.getPropertyValue('--bg-secondary').trim() || '#f5f5f5',
    tertiaryColor: s.getPropertyValue('--bg-hover').trim() || '#eee',
  };
}

export async function ensureMermaidLoaded(): Promise<void> {
  if (mermaidModule) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const mod = await import('mermaid');
    mermaidModule = mod.default;
    mermaidModule.initialize({
      startOnLoad: false,
      theme: isDark() ? 'dark' : 'default',
      themeVariables: resolveThemeColors(),
    });
  })();

  return loadingPromise;
}

export async function renderMermaid(
  code: string,
): Promise<{ svg: string } | { error: string }> {
  await ensureMermaidLoaded();

  // Enqueue: wait for previous render to finish before starting this one
  const result = new Promise<{ svg: string } | { error: string }>((resolve) => {
    renderQueue = renderQueue.then(async () => {
      const id = `mermaid-${++renderCounter}`;
      try {
        const { svg } = await mermaidModule.render(id, code);
        resolve({ svg });
      } catch (e) {
        resolve({ error: e instanceof Error ? e.message : 'Render failed' });
      }
    });
  });

  return result;
}

/**
 * Re-initialize mermaid with updated theme. Called when theme changes.
 */
export function updateMermaidTheme(): void {
  if (!mermaidModule) return;
  mermaidModule.initialize({
    startOnLoad: false,
    theme: isDark() ? 'dark' : 'default',
    themeVariables: resolveThemeColors(),
  });
}
