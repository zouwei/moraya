/**
 * MCP Marketplace — unified multi-source registry browser
 * Data sources: Official MCP Registry, LobeHub, Smithery
 */

import { fetch } from '@tauri-apps/plugin-http';
import { load } from '@tauri-apps/plugin-store';

// ── Types ──

export interface MarketplaceServer {
  id: string;
  name: string;
  description: string;
  author?: string;
  icon?: string;
  version?: string;
  homepage?: string;
  repository?: string;
  /** Install / use count (LobeHub: installCount, Smithery: useCount) */
  popularity?: number;
  /** GitHub stars (LobeHub only) */
  stars?: number;
  verified?: boolean;
  tags?: string[];
  install?: MarketplaceInstallInfo;
}

export interface MarketplaceInstallInfo {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envVars?: Array<{
    name: string;
    description: string;
    isSecret: boolean;
  }>;
}

export type MarketplaceSource = 'official' | 'lobehub' | 'smithery';

export interface MarketplaceSearchParams {
  query: string;
  page: number;
  pageSize: number;
}

export interface MarketplaceSearchResult {
  servers: MarketplaceServer[];
  totalCount: number;
  hasMore: boolean;
}

// ── Adapters ──

interface MarketplaceAdapter {
  search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult>;
}

/** Official MCP Registry — cursor-based pagination mapped to page numbers */
const officialAdapter: MarketplaceAdapter = {
  // Cache cursors keyed by `query:page`
  _cursors: new Map<string, string>(),

  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
    if (params.query) url.searchParams.set('search', params.query);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(params.pageSize));

    // For pages > 1, look up cached cursor
    if (params.page > 1) {
      const cursorKey = `${params.query}:${params.page}`;
      const cursor = (this as any)._cursors.get(cursorKey);
      if (cursor) url.searchParams.set('cursor', cursor);
    }

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    const data = await res.json();

    // Cache next cursor
    if (data.metadata?.nextCursor) {
      const nextKey = `${params.query}:${params.page + 1}`;
      (this as any)._cursors.set(nextKey, data.metadata.nextCursor);
    }

    const servers: MarketplaceServer[] = (data.servers || []).map((entry: any) => {
      const s = entry.server || entry;
      const pkg = s.packages?.[0];
      const remote = s.remotes?.[0];

      let install: MarketplaceInstallInfo | undefined;
      if (pkg && pkg.registryType === 'npm') {
        install = {
          transport: (pkg.transport as 'stdio') || 'stdio',
          command: 'npx',
          args: ['-y', pkg.identifier],
          envVars: (pkg.environmentVariables || []).map((ev: any) => ({
            name: ev.name,
            description: ev.description || '',
            isSecret: ev.isSecret ?? false,
          })),
        };
      } else if (remote) {
        install = {
          transport: remote.type === 'streamable-http' ? 'http' : (remote.type as 'http' | 'sse'),
          url: remote.url,
        };
      }

      // Extract author from name pattern "namespace/slug" or repository URL
      const nameStr: string = s.name || '';
      let author: string | undefined;
      if (nameStr.includes('/')) {
        // "ai.aliengiraffe/spotdb" → "aliengiraffe", "microsoft/playwright" → "microsoft"
        const ns = nameStr.split('/')[0];
        author = ns.includes('.') ? ns.split('.').pop() : ns;
      } else if (s.repository?.url) {
        const ghMatch = (s.repository.url as string).match(/github\.com\/([^/]+)/);
        if (ghMatch) author = ghMatch[1];
      }

      return {
        id: nameStr,
        name: s.title || nameStr,
        description: s.description || '',
        author,
        version: s.version,
        homepage: s.websiteUrl,
        repository: s.repository?.url,
        icon: s.icons?.[0]?.src,
        install,
      };
    });

    return {
      servers,
      totalCount: servers.length, // Official API doesn't expose total
      hasMore: !!data.metadata?.nextCursor,
    };
  },
} as MarketplaceAdapter & { _cursors: Map<string, string> };

/** LobeHub MCP Marketplace */
const lobehubAdapter: MarketplaceAdapter = {
  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const url = new URL('https://market.lobehub.com/api/v1/plugins');
    if (params.query) url.searchParams.set('search', params.query);
    url.searchParams.set('page', String(params.page));
    url.searchParams.set('pageSize', String(params.pageSize));
    url.searchParams.set('sort', 'installCount');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`LobeHub error: ${res.status}`);
    const data = await res.json();

    const servers: MarketplaceServer[] = (data.items || []).map((item: any) => {
      const install: MarketplaceInstallInfo | undefined =
        item.connectionType === 'local' || item.connectionType === 'hybrid'
          ? {
              transport: 'stdio' as const,
              command: 'npx',
              args: ['-y', item.identifier],
            }
          : undefined;

      return {
        id: item.identifier || '',
        name: item.name || item.identifier || '',
        description: item.description || '',
        author: item.author,
        icon: item.icon,
        version: item.version,
        homepage: item.homepage,
        repository: item.github?.url,
        popularity: item.installCount,
        stars: item.github?.stars,
        verified: item.isValidated || item.isOfficial,
        tags: item.category ? [item.category] : undefined,
        install,
      };
    });

    return {
      servers,
      totalCount: data.totalCount || 0,
      hasMore: params.page < (data.totalPages || 1),
    };
  },
};

/** Smithery Registry */
const smitheryAdapter: MarketplaceAdapter = {
  async search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult> {
    const url = new URL('https://registry.smithery.ai/servers');
    if (params.query) url.searchParams.set('q', params.query);
    url.searchParams.set('page', String(params.page));
    url.searchParams.set('pageSize', String(params.pageSize));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Smithery error: ${res.status}`);
    const data = await res.json();

    const servers: MarketplaceServer[] = (data.servers || []).map((s: any) => ({
      id: s.qualifiedName || '',
      name: s.displayName || s.qualifiedName || '',
      description: s.description || '',
      author: s.namespace || undefined,
      icon: s.iconUrl,
      homepage: s.homepage,
      popularity: s.useCount,
      verified: s.verified,
      install: undefined,
    }));

    return {
      servers,
      totalCount: data.pagination?.totalCount || 0,
      hasMore: params.page < (data.pagination?.totalPages || 1),
    };
  },
};

// ── Unified API ──

const adapters: Record<MarketplaceSource, MarketplaceAdapter> = {
  official: officialAdapter,
  lobehub: lobehubAdapter,
  smithery: smitheryAdapter,
};

export async function searchMarketplace(
  source: MarketplaceSource,
  params: MarketplaceSearchParams,
): Promise<MarketplaceSearchResult> {
  return adapters[source].search(params);
}

// ── Source persistence ──

const MCP_STORE_FILE = 'mcp-config.json';
const MARKETPLACE_SOURCE_KEY = 'marketplaceSource';

export async function loadMarketplaceSource(): Promise<MarketplaceSource> {
  try {
    const store = await load(MCP_STORE_FILE);
    const source = await store.get<MarketplaceSource>(MARKETPLACE_SOURCE_KEY);
    if (source && ['official', 'lobehub', 'smithery'].includes(source)) return source;
  } catch { /* first launch */ }
  return 'lobehub';
}

export async function saveMarketplaceSource(source: MarketplaceSource): Promise<void> {
  try {
    const store = await load(MCP_STORE_FILE);
    await store.set(MARKETPLACE_SOURCE_KEY, source);
    await store.save();
  } catch { /* ignore */ }
}

export const MARKETPLACE_SOURCES: Array<{ value: MarketplaceSource; labelKey: string }> = [
  { value: 'lobehub', labelKey: 'mcp.marketplace.sourceLobehub' },
  { value: 'smithery', labelKey: 'mcp.marketplace.sourceSmithery' },
  { value: 'official', labelKey: 'mcp.marketplace.sourceOfficial' },
];
