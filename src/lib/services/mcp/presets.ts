/**
 * MCP Server Presets - one-click add popular MCP servers
 */

import type { MCPServerConfig } from './types';

export interface MCPPreset {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  createConfig: () => Omit<MCPServerConfig, 'id'>;
}

export const MCP_PRESETS: MCPPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, search, and manage local files',
    descriptionZh: '读取、搜索和管理本地文件',
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
    description: 'Fetch web pages and convert to markdown',
    descriptionZh: '抓取网页并转换为 Markdown',
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
    description: 'Read and search Git repositories',
    descriptionZh: '读取和搜索 Git 仓库',
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
    description: 'Persistent knowledge graph for AI memory',
    descriptionZh: 'AI 持久化知识图谱记忆',
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
