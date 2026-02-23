/**
 * Container Manager — orchestrates AI-created dynamic MCP services.
 *
 * Handles lifecycle: create → connect → (save) → remove/cleanup.
 * Reuses existing MCP infrastructure (mcpStore, connectServer, disconnectServer).
 */

import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { load } from '@tauri-apps/plugin-store';
import { exists, remove, mkdir } from '@tauri-apps/plugin-fs';
import { ask } from '@tauri-apps/plugin-dialog';
import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import { settingsStore } from '$lib/stores/settings-store';
import { mcpStore, connectServer, disconnectServer } from './mcp-manager';
import { containerStore, type DynamicService } from './container-store';
import { MCP_RUNTIME_JS } from './mcp-runtime';
import type { MCPServerConfig } from './types';

/** Extract a human-readable message from unknown caught values. */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

const DYNAMIC_STORE_FILE = 'dynamic-mcp-services.json';

let cachedAppDataDir: string | null = null;

async function getBaseDir(): Promise<string> {
  if (!cachedAppDataDir) {
    cachedAppDataDir = await appDataDir();
  }
  return cachedAppDataDir;
}

async function getServicesDir(): Promise<string> {
  const base = await getBaseDir();
  // Ensure trailing separator — appDataDir() may omit it on some platforms
  const sep = base.endsWith('/') || base.endsWith('\\') ? '' : '/';
  return `${base}${sep}mcp-services`;
}

// ── Initialization ──

export async function initContainerManager(): Promise<void> {
  // 1. Check Node.js availability
  try {
    const version = await invoke<string>('check_command_exists', { command: 'node' });
    const major = parseInt(version.replace('v', '').split('.')[0], 10);
    containerStore.setNodeStatus(major >= 18, version.trim());
    if (major < 18) {
      console.warn('[Container] Node.js version too old:', version.trim(), '(need ≥18)');
      return;
    }
  } catch {
    containerStore.setNodeStatus(false, null);
    console.warn('[Container] Node.js not found');
    return;
  }

  // 2. Load and reconnect saved services
  try {
    const store = await load(DYNAMIC_STORE_FILE);
    const saved = await store.get<DynamicService[]>('savedServices');
    if (saved && saved.length > 0) {
      for (const svc of saved) {
        containerStore.addService({ ...svc, status: 'stopped' });
      }

      // Auto-reconnect saved services
      for (const svc of saved) {
        try {
          await reconnectSavedService(svc);
        } catch (e: any) {
          console.error(`[Container] Failed to reconnect "${svc.name}":`, e);
          containerStore.updateService(svc.id, {
            status: 'error',
            error: `Reconnect failed: ${errMsg(e)}`,
          });
        }
      }
    }
  } catch {
    /* first launch — no saved services */
  }
}

// ── Runtime Management ──

async function ensureRuntime(): Promise<string> {
  const servicesDir = await getServicesDir();
  const runtimeDir = `${servicesDir}/runtime`;
  const runtimePath = `${runtimeDir}/mcp-runtime.js`;

  try {
    const fileExists = await exists(runtimePath);
    if (!fileExists) {
      await mkdir(runtimeDir, { recursive: true });
      await invoke('write_file', { path: runtimePath, content: MCP_RUNTIME_JS });
    }
  } catch {
    // Directory might not exist yet
    await mkdir(runtimeDir, { recursive: true });
    await invoke('write_file', { path: runtimePath, content: MCP_RUNTIME_JS });
  }

  containerStore.setRuntimeReady(true);
  return runtimePath;
}

// ── Service CRUD ──

export interface CreateServiceParams {
  name: string;
  description: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  handlersCode: string;
  env?: Record<string, string>;
}

export async function createService(params: CreateServiceParams): Promise<DynamicService> {
  const { name, description, tools, handlersCode, env } = params;

  // Ensure runtime is ready
  const runtimePath = await ensureRuntime();

  // Create service directory (always saved — persist unless user deletes)
  const serviceId = `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const servicesDir = await getServicesDir();
  const serviceDir = `${servicesDir}/saved/${serviceId}`;
  await mkdir(serviceDir, { recursive: true });

  // Write service files
  const definition = JSON.stringify({ name, description, tools }, null, 2);
  await invoke('write_file', { path: `${serviceDir}/definition.json`, content: definition });
  await invoke('write_file', { path: `${serviceDir}/handlers.js`, content: handlersCode });

  // Build MCP server config
  const mcpServerId = `ai-svc-${serviceId}`;
  const config: MCPServerConfig = {
    id: mcpServerId,
    name: `[AI] ${name}`,
    description,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [runtimePath, '--dir', serviceDir],
      env: env || {},
    },
    enabled: true,
  };

  // Track in container store
  const service: DynamicService = {
    id: serviceId,
    name,
    description,
    status: 'starting',
    lifecycle: 'saved',
    mcpServerId,
    serviceDir,
    createdAt: Date.now(),
    tools: tools.map((t) => t.name),
    env,
  };
  containerStore.addService(service);

  // Security confirmation before running AI-generated code (skip if auto-approve enabled)
  if (!settingsStore.getState().mcpAutoApprove) {
    const tr = get(t);
    const confirmed = await ask(
      tr('mcp.aiServices.launchConfirmMsg', {
        name,
        tools: tools.map((t) => t.name).join(', '),
      }),
      {
        title: tr('mcp.aiServices.launchConfirmTitle'),
        kind: 'warning',
        okLabel: tr('mcp.aiServices.launchConfirmOk'),
        cancelLabel: tr('mcp.aiServices.launchConfirmCancel'),
      },
    );
    if (!confirmed) {
      containerStore.updateService(serviceId, { status: 'error', error: 'Cancelled by user' });
      throw new Error('Service launch cancelled by user');
    }
  }

  // Connect using existing MCP infrastructure
  try {
    mcpStore.addServer(config);
    await connectServer(config);
    containerStore.updateService(serviceId, { status: 'running' });

    // Persist immediately so service survives app restart
    await persistSavedServices();

    // Notify UI
    window.dispatchEvent(
      new CustomEvent('moraya:dynamic-service-created', {
        detail: { name, tools: tools.map((t) => t.name) },
      }),
    );

    return { ...service, status: 'running' };
  } catch (e: any) {
    containerStore.updateService(serviceId, {
      status: 'error',
      error: errMsg(e),
    });
    throw new Error(`Service "${name}" failed to start: ${errMsg(e)}`);
  }
}

export async function saveService(serviceId: string): Promise<void> {
  const state = containerStore.getState();
  const service = state.services.find((s) => s.id === serviceId);
  if (!service) throw new Error(`Service not found: ${serviceId}`);
  if (service.lifecycle === 'saved') return; // Already saved

  // Copy files from temp to saved
  const servicesDir = await getServicesDir();
  const savedDir = `${servicesDir}/saved/${service.name}`;
  await mkdir(savedDir, { recursive: true });

  const defContent = await invoke<string>('read_file', {
    path: `${service.serviceDir}/definition.json`,
  });
  const handlersContent = await invoke<string>('read_file', {
    path: `${service.serviceDir}/handlers.js`,
  });
  await invoke('write_file', { path: `${savedDir}/definition.json`, content: defContent });
  await invoke('write_file', { path: `${savedDir}/handlers.js`, content: handlersContent });

  // Update service record
  containerStore.updateService(serviceId, {
    lifecycle: 'saved',
    serviceDir: savedDir,
  });

  await persistSavedServices();
}

export async function removeService(serviceId: string): Promise<void> {
  const state = containerStore.getState();
  const service = state.services.find((s) => s.id === serviceId);
  if (!service) return;

  // Disconnect MCP server
  try {
    await disconnectServer(service.mcpServerId);
  } catch {
    /* already disconnected */
  }
  mcpStore.removeServer(service.mcpServerId);

  // Clean up files
  try {
    await remove(service.serviceDir, { recursive: true });
  } catch {
    /* files may already be gone */
  }

  containerStore.removeService(serviceId);

  if (service.lifecycle === 'saved') {
    await persistSavedServices();
  }
}

export function listServices(): DynamicService[] {
  return containerStore.getState().services;
}

export async function cleanupTempServices(): Promise<void> {
  const state = containerStore.getState();
  const tempServices = state.services.filter((s) => s.lifecycle === 'temp');

  for (const svc of tempServices) {
    try {
      await disconnectServer(svc.mcpServerId);
    } catch {
      /* ignore */
    }
    mcpStore.removeServer(svc.mcpServerId);
    containerStore.removeService(svc.id);

    try {
      await remove(svc.serviceDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Persistence ──

async function persistSavedServices(): Promise<void> {
  try {
    const state = containerStore.getState();
    const saved = state.services.filter((s) => s.lifecycle === 'saved');
    const store = await load(DYNAMIC_STORE_FILE);
    await store.set('savedServices', saved);
    await store.save();
  } catch {
    /* ignore */
  }
}

async function reconnectSavedService(svc: DynamicService): Promise<void> {
  const runtimePath = await ensureRuntime();

  // Verify service files still exist
  const defExists = await exists(`${svc.serviceDir}/definition.json`);
  if (!defExists) {
    throw new Error('Service files missing');
  }

  const config: MCPServerConfig = {
    id: svc.mcpServerId,
    name: `[AI] ${svc.name}`,
    description: svc.description,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [runtimePath, '--dir', svc.serviceDir],
      env: svc.env || {},
    },
    enabled: true,
  };

  // Saved services were already approved by the user when first created —
  // skip security confirmation on reconnect to avoid prompting on every app launch.

  mcpStore.addServer(config);
  await connectServer(config);
  containerStore.updateService(svc.id, { status: 'running' });
}
