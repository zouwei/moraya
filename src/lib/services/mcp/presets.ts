/**
 * MCP Server Presets - one-click add popular MCP servers
 */

import type { MCPServerConfig } from './types';

export interface MCPPreset {
  id: string;
  name: string;
  /** i18n key for the preset description, resolved via $t() at display time */
  descriptionKey: string;
  createConfig: () => Omit<MCPServerConfig, 'id'>;
}

export const MCP_PRESETS: MCPPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    descriptionKey: 'mcp.servers.presetDesc.filesystem',
    createConfig: () => ({
      name: 'Filesystem',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/'],
      },
      enabled: true,
    }),
  },
  {
    id: 'fetch',
    name: 'Fetch',
    descriptionKey: 'mcp.servers.presetDesc.fetch',
    createConfig: () => ({
      name: 'Fetch',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@tokenizin/mcp-npx-fetch'],
      },
      enabled: true,
    }),
  },
  {
    id: 'git',
    name: 'Git',
    descriptionKey: 'mcp.servers.presetDesc.git',
    createConfig: () => ({
      name: 'Git',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@cyanheads/git-mcp-server'],
      },
      enabled: true,
    }),
  },
  {
    id: 'memory',
    name: 'Memory',
    descriptionKey: 'mcp.servers.presetDesc.memory',
    createConfig: () => ({
      name: 'Memory',
      transport: {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
      enabled: true,
    }),
  },
];
