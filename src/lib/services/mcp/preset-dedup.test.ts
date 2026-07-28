import { describe, it, expect, vi } from 'vitest';

// mcp-manager pulls in Tauri plugins at import time; the dedup rule under test
// is pure, so stub the IO surface rather than the logic.
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { dropLegacyPresetDuplicates } from './mcp-manager';
import type { MCPServerConfig } from './types';

const server = (id: string, name: string): MCPServerConfig =>
  ({
    id,
    name,
    enabled: true,
    transport: { type: 'stdio', command: 'node', args: [] },
  }) as unknown as MCPServerConfig;

describe('dropLegacyPresetDuplicates', () => {
  it('keeps a user server that merely shares a preset name', () => {
    // The regression: `mcp-<timestamp>` is what every manually added server
    // still gets, so the old name-only rule deleted this on every launch.
    const servers = [server('mcp-1730000000000', 'Git')];
    expect(dropLegacyPresetDuplicates(servers)).toEqual(servers);
  });

  it('keeps marketplace and AI-created servers with preset names', () => {
    const servers = [
      server('mcp-1730000000000-ab12', 'Memory'),
      server('ai-svc-dyn-1730000000001-xyz', 'Filesystem'),
    ];
    expect(dropLegacyPresetDuplicates(servers)).toEqual(servers);
  });

  it('drops the legacy twin only when the preset-id server is also present', () => {
    const preset = server('preset-git', 'Git');
    const legacy = server('mcp-1690000000000', 'Git');
    expect(dropLegacyPresetDuplicates([preset, legacy])).toEqual([preset]);
  });

  it('never drops a preset-id server', () => {
    const servers = [server('preset-memory', 'Memory'), server('preset-git', 'Git')];
    expect(dropLegacyPresetDuplicates(servers)).toEqual(servers);
  });

  it('leaves servers with non-preset names alone', () => {
    const servers = [server('mcp-1', 'My Custom Tool'), server('preset-git', 'Git')];
    expect(dropLegacyPresetDuplicates(servers)).toEqual(servers);
  });

  it('is idempotent', () => {
    const servers = [server('preset-git', 'Git'), server('mcp-1', 'Git')];
    const once = dropLegacyPresetDuplicates(servers);
    expect(dropLegacyPresetDuplicates(once)).toEqual(once);
  });
});
