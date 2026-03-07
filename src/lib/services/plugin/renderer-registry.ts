import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * Built-in renderer plugin registry.
 *
 * Each entry describes a third-party JS library that can render a custom
 * code block language inside the editor's ProseMirror NodeView.
 *
 * CDN URLs point to cdn.jsdelivr.net (primary).  The Rust command
 * `download_renderer_plugin` validates the URL against an allowlist and
 * caches the file under `{appDataDir}/renderer-plugins/{id}/index.js`.
 *
 * @see src-tauri/src/commands/plugin_manager.rs  download_renderer_plugin
 */

export interface RendererPlugin {
  /** Unique short ID (alphanumeric, hyphen, underscore) */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** One-line description shown in the plugin card */
  description: string;
  /** Approximate GitHub star count (static, updated with each release) */
  stars: number;
  /** npm package name (used by sync-renderer-plugins.mjs for version tracking) */
  npmPackage: string;
  /** UMD global export name. Empty string = ESM-only, loaded via dynamic import() */
  exportName: string;
  /** Approximate bundle size in KB (shown as warning when > 500 KB) */
  sizeKb: number;
  /** Code block language identifiers that trigger this renderer */
  languages: string[];
  /** Brief homepage / docs URL */
  homepage: string;
  /** CDN URL template. Use the frozen version from renderer-versions.json */
  cdnUrl: string;
  /**
   * English-only hint injected into the AI system prompt when this plugin is
   * enabled.  Tells the AI which code block format to use.
   */
  aiHint: string;
  /**
   * Render function: given a container element, the raw source string, and the
   * loaded module (UMD global or ESM default), produce visual output.
   * Must be idempotent — container is cleared before each call.
   */
  render(
    container: HTMLElement,
    source: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod: any
  ): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Vega-Lite data URL resolver
// ---------------------------------------------------------------------------

/**
 * Vega's official sample-datasets CDN base — used to resolve relative data URLs
 * such as `"data/cars.json"` that appear in Vega-Lite documentation examples.
 */
const VEGA_DATASETS_BASE = 'https://vega.github.io/vega-datasets/';

/**
 * Recursively walk a Vega-Lite spec and replace any `data: {url: "..."}` with
 * inline `data: {values: [...]}` fetched via Tauri HTTP (bypasses WebView CSP).
 * Relative URLs are resolved against the official Vega sample-datasets CDN.
 * The original `format` field is preserved so topojson feature extraction works.
 */
async function resolveVegaDataUrls(spec: unknown): Promise<unknown> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const s = { ...(spec as Record<string, unknown>) };

  if (s.data && typeof s.data === 'object' && !Array.isArray(s.data)) {
    const data = s.data as Record<string, unknown>;
    if (typeof data.url === 'string') {
      // Resolve relative paths (e.g. "data/cars.json") against Vega datasets CDN
      const rawUrl = data.url;
      const url = /^https?:\/\//i.test(rawUrl)
        ? rawUrl
        : new URL(rawUrl, VEGA_DATASETS_BASE).href;
      try {
        const resp = await tauriFetch(url);
        const text = await resp.text();
        // Preserve format (e.g. topojson feature extraction must survive URL→values conversion)
        const newData: Record<string, unknown> = { values: JSON.parse(text) };
        if (data.format !== undefined) newData.format = data.format;
        s.data = newData;
      } catch {
        // Keep original data reference; vega will fail with its own error
      }
    }
  }

  // Recurse into composite views
  for (const key of ['layer', 'concat', 'vconcat', 'hconcat']) {
    if (Array.isArray(s[key])) {
      s[key] = await Promise.all((s[key] as unknown[]).map(resolveVegaDataUrls));
    }
  }
  if (s.spec && typeof s.spec === 'object') {
    s.spec = await resolveVegaDataUrls(s.spec);
  }

  return s;
}

// ---------------------------------------------------------------------------
// Registry — 10 built-in renderer plugins
// ---------------------------------------------------------------------------

export const RENDERER_PLUGINS: RendererPlugin[] = [
  // ── WaveDrom ──────────────────────────────────────────────────────────────
  {
    id: 'wavedrom',
    name: 'WaveDrom',
    description: 'Digital timing diagram and waveform renderer for hardware / RTL design.',
    stars: 3700,
    npmPackage: 'wavedrom',
    exportName: 'WaveDrom',
    sizeKb: 200,
    languages: ['wavedrom'],
    homepage: 'https://wavedrom.com',
    // WaveDrom 3.x separates the skin from core — use combine endpoint to
    // bundle wavedrom.min.js + skins/default.js into one download so that
    // window.WaveSkin is available when RenderWaveForm is called.
    cdnUrl: 'https://cdn.jsdelivr.net/combine/npm/wavedrom@{version}/wavedrom.min.js,npm/wavedrom@{version}/skins/default.js',
    aiHint:
      'Use ```wavedrom code blocks to draw digital timing diagrams (signal waveforms). ' +
      'Format: JSON with a "signal" array, e.g. {"signal":[{"name":"clk","wave":"p..."}]}.',
    render(container, source, mod) {
      const WaveDrom = mod as {
        // v3 API (lowercase 'r'); v2 used uppercase 'RenderWaveForm'
        renderWaveForm?: (idx: number, waveJson: unknown, outputPrefix: string) => void;
        RenderWaveForm?: (idx: number, waveJson: unknown, outputPrefix: string) => void;
      };
      // Support both WaveDrom v3 (renderWaveForm) and v2 (RenderWaveForm)
      const renderFn = WaveDrom.renderWaveForm ?? WaveDrom.RenderWaveForm;
      if (typeof renderFn !== 'function') throw new Error('WaveDrom render API not found');

      const prefix = `wd-${Math.random().toString(36).slice(2)}`;
      container.id = `${prefix}0`;

      // WaveDrom uses JS object literal syntax (unquoted keys + single quotes),
      // not strict JSON. Parse safely: try JSON first, then convert JS notation.
      let waveJson: unknown;
      try {
        waveJson = JSON.parse(source.trim());
      } catch {
        // 1. Quote unquoted object keys  { signal: → { "signal":
        // 2. Replace single-quoted strings 'clk' → "clk"
        // 3. Remove trailing commas before } or ]
        const jsonified = source.trim()
          .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
          .replace(/'([^'\\]*)'/g, '"$1"')
          .replace(/,(\s*[}\]])/g, '$1');
        waveJson = JSON.parse(jsonified);
      }

      renderFn.call(WaveDrom, 0, waveJson, prefix);

      // WaveDrom renders SVG with fixed pixel width; make it fill the container.
      const svg = container.querySelector('svg');
      if (svg) {
        const w = svg.getAttribute('width');
        const h = svg.getAttribute('height');
        if (w && h && !svg.getAttribute('viewBox')) {
          svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        }
        svg.setAttribute('width', '100%');
        svg.removeAttribute('height');
      }
    },
  },

  // ── Nomnoml ───────────────────────────────────────────────────────────────
  {
    id: 'nomnoml',
    name: 'Nomnoml',
    description: 'Readable UML class and component diagrams from plain text notation.',
    stars: 1800,
    npmPackage: 'nomnoml',
    exportName: 'nomnoml',
    sizeKb: 150,
    languages: ['nomnoml'],
    homepage: 'https://nomnoml.com',
    // nomnoml@1.7.0 requires graphre as external peer — combine with graphre so
    // window.graphre is set before nomnoml loads.
    cdnUrl: 'https://cdn.jsdelivr.net/combine/npm/graphre@0.1.3/dist/graphre.js,npm/nomnoml@{version}/dist/nomnoml.min.js',
    aiHint:
      'Use ```nomnoml code blocks to draw UML-style class and component diagrams. ' +
      'Example: [Customer|name;email]->[Order|id;total].',
    render(container, source, mod) {
      const nomnoml = mod as { renderSvg: (src: string) => string };
      const svg = nomnoml.renderSvg(source);
      container.innerHTML = svg;
      // Make SVG fill container width
      const svgEl = container.querySelector('svg');
      if (svgEl) {
        const w = svgEl.getAttribute('width');
        const h = svgEl.getAttribute('height');
        if (w && h && !svgEl.getAttribute('viewBox')) {
          svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
        }
        svgEl.setAttribute('width', '100%');
        svgEl.removeAttribute('height');
      }
    },
  },

  // ── ECharts ───────────────────────────────────────────────────────────────
  {
    id: 'echarts',
    name: 'ECharts',
    description: 'Feature-rich interactive chart library by Apache — line, bar, pie, scatter and more.',
    stars: 60000,
    npmPackage: 'echarts',
    exportName: 'echarts',
    sizeKb: 980,
    languages: ['echarts'],
    homepage: 'https://echarts.apache.org',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/echarts@{version}/dist/echarts.min.js',
    aiHint:
      'Use ```echarts code blocks for rich interactive charts (line, bar, pie, scatter, etc.). ' +
      'Content must be a valid ECharts option JSON object.',
    render(container, source, mod) {
      const echarts = mod as {
        init: (el: HTMLElement) => { setOption: (opt: unknown) => void };
      };
      if (!container.style.height) container.style.height = '360px';
      const chart = echarts.init(container);
      chart.setOption(JSON.parse(source));
    },
  },

  // ── Vega-Lite (via vega-embed) ────────────────────────────────────────────
  {
    id: 'vega-lite',
    name: 'Vega-Lite',
    description: 'Declarative statistical visualization grammar for charts and linked views.',
    stars: 3800,
    // jsdelivr combine: vega (runtime) + vega-lite (compiler) + vega-embed (renderer)
    // vega-embed@6 treats vega/vega-lite as peer deps — must load all three together
    npmPackage: 'vega-embed',
    exportName: 'vegaEmbed',
    sizeKb: 2500,
    languages: ['vega-lite', 'vegalite', 'vega-embed', 'vega'],
    homepage: 'https://vega.github.io/vega-lite',
    cdnUrl:
      'https://cdn.jsdelivr.net/combine/' +
      'npm/vega@5.30.0/build/vega.min.js,' +
      'npm/vega-lite@5.18.1/build/vega-lite.min.js,' +
      'npm/vega-embed@6.26.0/build/vega-embed.min.js',
    aiHint:
      'Use ```vega-lite code blocks for declarative statistical visualisations. ' +
      'Content must be a valid Vega-Lite JSON spec with $schema, mark, and encoding fields. ' +
      'Always use inline data: {"values": [...]} instead of {"url": "..."} since external URLs cannot be fetched.',
    async render(container, source, mod) {
      // vega-embed UMD sets window.vegaEmbed = { default: fn, vega, vegaLite, ... }
      // Fall back: .default → .embed → mod itself
      const raw = mod as Record<string, unknown>;
      const embedFn = (raw.default ?? raw.embed ?? mod) as (
        el: HTMLElement,
        spec: unknown,
        opts?: Record<string, unknown>
      ) => Promise<unknown>;
      container.innerHTML = '';
      const spec = JSON.parse(source) as Record<string, unknown>;
      // If the spec doesn't specify dimensions, use responsive width and a
      // sensible default height so charts don't render at Vega-Lite's 200px default.
      // Explicit numeric values in the spec are preserved as-is.
      if (spec.width === undefined) spec.width = 'container';
      if (spec.height === undefined) spec.height = 350;
      // Pre-fetch any external data URLs via Tauri HTTP (bypasses WebView CSP).
      const resolved = await resolveVegaDataUrls(spec);
      await embedFn(container, resolved, { renderer: 'svg', actions: false });
    },
  },

  // ── ABCjs ─────────────────────────────────────────────────────────────────
  {
    id: 'abcjs',
    name: 'ABCjs',
    description: 'Renders music sheet notation from ABC notation text in the browser.',
    stars: 1500,
    npmPackage: 'abcjs',
    exportName: 'ABCJS',
    sizeKb: 320,
    languages: ['abc', 'abcjs'],
    homepage: 'https://paulrosen.github.io/abcjs',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/abcjs@{version}/dist/abcjs-basic-min.js',
    aiHint:
      'Use ```abc code blocks to render music sheet notation. ' +
      'Content uses ABC notation format (X:1, T:title, M:4/4, L:1/8, K:C, then notes).',
    render(container, source, mod) {
      const ABCJS = mod as {
        renderAbc: (el: HTMLElement, source: string, opts?: object) => unknown;
      };
      ABCJS.renderAbc(container, source, { responsive: 'resize' });
    },
  },

  // ── jsMind ────────────────────────────────────────────────────────────────
  {
    id: 'jsmind',
    name: 'jsMind',
    description: 'Pure-JavaScript mind map visualizer — render interactive mind maps from markdown or JSON.',
    stars: 3600,
    npmPackage: 'jsmind',
    exportName: 'jsMind',
    sizeKb: 50,
    languages: ['jsmind', 'mindmap'],
    homepage: 'https://hizzgdev.github.io/jsmind',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/jsmind@{version}/es6/jsmind.js',
    aiHint:
      'Use ```jsmind code blocks to render mind maps. ' +
      'Use markdown heading format: # Root, ## Branch, ### Sub-branch, - leaf item. ' +
      'Or use JSON: {"meta":{"name":"map"},"format":"node_tree","data":{"id":"root","topic":"Center","children":[]}}.',
    render(container, source, mod) {
      const jsMind = mod as { show: (options: object, mind: object) => void };

      // Inject jsMind CSS once (CSP blocks external stylesheets, so embed inline)
      const CSS_ID = 'jsmind-embedded-css';
      if (!document.getElementById(CSS_ID)) {
        const style = document.createElement('style');
        style.id = CSS_ID;
        style.textContent = '.jsmind-inner{position:relative;overflow:hidden;width:100%;height:100%;outline:none;user-select:none}.jsmind-inner canvas{position:absolute}svg.jsmind,canvas.jsmind{position:absolute;z-index:1}jmnodes{position:absolute;z-index:2;background-color:rgba(0,0,0,0)}jmnode{position:absolute;cursor:default;max-width:400px;padding:10px;background-color:#fff;color:#333;border-radius:5px;box-shadow:1px 1px 1px #666;font:16px/1.125 Verdana,Arial,Helvetica,sans-serif}jmnode:hover{box-shadow:2px 2px 8px #000;background-color:#ebebeb}jmnode.selected{background-color:#fff;color:#333;box-shadow:1px 1px 1px #666}jmnode.root{font-size:20px;font-weight:bold}jmexpander{position:absolute;width:11px;height:11px;display:block;overflow:hidden;line-height:12px;font-size:10px;text-align:center;border-radius:6px;border-width:1px;border-style:solid;cursor:pointer;border-color:gray}jmexpander:hover{border-color:#000}';
        document.head.appendChild(style);
      }

      // Parse source: try JSON first, then markdown heading format
      type MindNode = { id: string; topic: string; direction?: string; children: MindNode[] };
      let mind: object;
      try {
        mind = JSON.parse(source);
      } catch {
        // Parse markdown heading format:
        //   # Root        → root node
        //   ## Branch     → level-2 child
        //   ### Sub       → level-3 child
        //   - leaf        → child of most recent heading
        const lines = source.split('\n').filter(l => l.trim());
        let idCounter = 0;
        const makeId = () => `n${++idCounter}`;
        const stack: (MindNode | null)[] = new Array(7).fill(null);
        let rootNode: MindNode | null = null;

        for (const line of lines) {
          const hm = line.match(/^(#{1,6})\s+(.+)/);
          const lm = line.match(/^[-*]\s+(.+)/);
          if (hm) {
            const level = hm[1].length;
            const node: MindNode = { id: level === 1 ? 'root' : makeId(), topic: hm[2].trim(), children: [] };
            stack[level] = node;
            for (let i = level + 1; i <= 6; i++) stack[i] = null;
            if (level === 1) {
              rootNode = node;
            } else {
              for (let pl = level - 1; pl >= 1; pl--) {
                if (stack[pl]) { stack[pl]!.children.push(node); break; }
              }
            }
          } else if (lm) {
            const node: MindNode = { id: makeId(), topic: lm[1].trim(), children: [] };
            for (let pl = 6; pl >= 1; pl--) {
              if (stack[pl]) { stack[pl]!.children.push(node); break; }
            }
          }
        }
        if (!rootNode) throw new Error('No root node — use # heading for the root');
        mind = { meta: { name: rootNode.topic, author: '', version: '' }, format: 'node_tree', data: rootNode };
      }

      // Force all non-root nodes to expand rightward so connection lines start
      // from the RIGHT border of each parent node (left-to-right tree layout).
      const mindObj = mind as { data?: { children?: MindNode[] } };
      function setAllRight(nodes: MindNode[]): void {
        for (const n of nodes) {
          n.direction = 'right';
          if (n.children?.length) setAllRight(n.children);
        }
      }
      if (mindObj.data?.children) {
        setAllRight(mindObj.data.children);
      }

      // ── Single-pass render + viewport clip ──────────────────────────────────
      // Strategy: render jsMind into a large inner wrapper (2400×2000px) so all
      // nodes are always within bounds.  jsMind centers root at (1200, 1000).
      // After rendering we measure real node positions, resize the outer container
      // to fit the content, and shift the wrapper with negative top/left so the
      // root appears at the top-left of the visible area.
      // Canvas + nodes are both inside the wrapper, so they always stay aligned.

      const WRAPPER_W = 2400;
      const WRAPPER_H = 2000;
      const wrapperId = `jm-${Math.random().toString(36).slice(2)}`;
      const wrapper = document.createElement('div');
      wrapper.id = wrapperId;
      wrapper.style.cssText = `position:absolute;left:0;top:0;width:${WRAPPER_W}px;height:${WRAPPER_H}px`;
      // Outer container: large temp height so wrapper is in the visible subtree
      // (needed for offsetTop/offsetLeft to return correct values in WKWebView)
      container.style.cssText = `position:relative;overflow:hidden;height:${WRAPPER_H}px`;
      container.appendChild(wrapper);
      jsMind.show({ container: wrapperId, editable: false }, mind);

      return new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          const jmNodes = wrapper.querySelectorAll('jmnode');
          let finalHeight = 400;
          let shiftX = 0;
          let shiftY = 0;

          if (jmNodes.length > 0) {
            let minTop = Infinity, maxBottom = -Infinity;
            jmNodes.forEach(node => {
              const el = node as HTMLElement;
              const t = el.offsetTop;
              const b = t + el.offsetHeight;
              if (t < minTop) minTop = t;
              if (b > maxBottom) maxBottom = b;
            });

            const rootEl =
              (wrapper.querySelector('jmnode[nodeid="root"]') as HTMLElement | null) ??
              (wrapper.querySelector('jmnode.root') as HTMLElement | null);

            if (rootEl) {
              const rootCenterY = rootEl.offsetTop + rootEl.offsetHeight / 2;
              const aboveRoot = Math.max(0, rootCenterY - minTop);
              const belowRoot = Math.max(0, maxBottom - rootCenterY);
              // Symmetric so jsMind's centering never clips either side; +80 padding
              finalHeight = Math.max(300, 2 * Math.max(aboveRoot, belowRoot) + 80);
              // Vertical shift: move the wrapper up so root is vertically centered
              // in the new (smaller) container
              shiftY = Math.max(0, rootCenterY - finalHeight / 2);
              // Horizontal shift: move root to left edge (40px padding)
              shiftX = Math.max(0, rootEl.offsetLeft - 40);
            } else {
              finalHeight = Math.max(300, maxBottom - minTop + 80);
              shiftY = Math.max(0, minTop - 40);
            }
          }

          // Resize outer container to content height
          container.style.height = `${finalHeight}px`;
          // Shift wrapper so the right portion of content is visible
          wrapper.style.top = `-${shiftY}px`;
          wrapper.style.left = `-${shiftX}px`;
          resolve();
        });
      });
    },
  },

  // ── Pintora ───────────────────────────────────────────────────────────────
  {
    id: 'pintora',
    name: 'Pintora',
    description: 'Text-to-diagram tool supporting sequence, activity, component, mindmap and Gantt.',
    stars: 900,
    npmPackage: '@pintora/standalone',
    exportName: 'pintora',
    sizeKb: 380,
    languages: ['pintora'],
    homepage: 'https://pintorajs.vercel.app',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/@pintora/standalone@{version}/lib/pintora-standalone.umd.min.js',
    aiHint:
      'Use ```pintora code blocks for text-based diagrams (sequence, activity, component, mindmap, gantt). ' +
      'Example: sequenceDiagram\n  A->B: Hello.',
    async render(container, source, mod) {
      const pintora = mod as {
        renderTo: (el: HTMLElement, opts: object) => Promise<void>;
      };
      await pintora.renderTo(container, { code: source, backgroundColor: 'transparent' });
    },
  },

  // ── Chart.js ──────────────────────────────────────────────────────────────
  {
    id: 'chartjs',
    name: 'Chart.js',
    description: 'Simple yet flexible JavaScript charting — bar, line, pie, radar, doughnut and more.',
    stars: 65000,
    npmPackage: 'chart.js',
    exportName: 'Chart',
    sizeKb: 200,
    languages: ['chartjs', 'chart'],
    homepage: 'https://www.chartjs.org',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/chart.js@{version}/dist/chart.umd.min.js',
    aiHint:
      'Use ```chartjs code blocks to render bar, line, pie, radar, and other Chart.js charts. ' +
      'Content must be a valid Chart.js config JSON with type, data, and optional options.',
    render(container, source, mod) {
      const Chart = mod as new (canvas: HTMLCanvasElement, config: unknown) => unknown;
      const canvas = document.createElement('canvas');
      container.appendChild(canvas);
      new Chart(canvas, JSON.parse(source));
    },
  },

  // ── Cytoscape.js ──────────────────────────────────────────────────────────
  {
    id: 'cytoscape',
    name: 'Cytoscape.js',
    description: 'Graph theory and network analysis library with rich interactive visualization.',
    stars: 10000,
    npmPackage: 'cytoscape',
    exportName: 'cytoscape',
    sizeKb: 290,
    languages: ['cytoscape'],
    homepage: 'https://js.cytoscape.org',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/cytoscape@{version}/dist/cytoscape.min.js',
    aiHint:
      'Use ```cytoscape code blocks to render interactive graph and network visualisations. ' +
      'Content must be a Cytoscape.js config JSON with elements (nodes and edges arrays).',
    render(container, source, mod) {
      const cytoscape = mod as (opts: object) => unknown;
      if (!container.style.height) container.style.height = '400px';
      cytoscape({ container, ...JSON.parse(source) });
    },
  },

  // ── Viz.js (Graphviz) ─────────────────────────────────────────────────────
  {
    id: 'viz',
    name: 'Viz.js (Graphviz)',
    description: 'Graphviz compiled to WebAssembly — renders DOT language directed and undirected graphs.',
    stars: 3100,
    npmPackage: '@viz-js/viz',
    exportName: 'Viz',
    sizeKb: 1500,
    languages: ['dot', 'graphviz'],
    homepage: 'https://github.com/mdaines/viz-js',
    cdnUrl: 'https://cdn.jsdelivr.net/npm/@viz-js/viz@{version}/lib/viz-standalone.js',
    aiHint:
      'Use ```dot code blocks to render Graphviz DOT language graphs (directed/undirected). ' +
      'Example: digraph G { A -> B -> C; }.',
    async render(container, source, mod) {
      // viz-standalone.js is UMD; loaded via <script> tag, window.Viz = { instance }
      const vizMod = mod as { instance: () => Promise<{ renderSVGElement: (src: string) => SVGElement }> };
      const viz = await vizMod.instance();
      container.innerHTML = '';
      container.appendChild(viz.renderSVGElement(source));
    },
  },
];

/** Quick lookup by plugin id */
export function getRendererPlugin(id: string): RendererPlugin | undefined {
  return RENDERER_PLUGINS.find((p) => p.id === id);
}

/** All language identifiers that have a registered renderer */
export const RENDERER_LANGUAGES = new Set<string>(
  RENDERER_PLUGINS.flatMap((p) => p.languages)
);
