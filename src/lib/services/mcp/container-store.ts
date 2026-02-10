import { writable, get } from 'svelte/store';

export interface DynamicService {
  id: string;
  name: string;
  description: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  lifecycle: 'temp' | 'saved';
  mcpServerId: string;
  serviceDir: string;
  createdAt: number;
  tools: string[];
  env?: Record<string, string>;
  error?: string;
}

interface ContainerState {
  services: DynamicService[];
  nodeAvailable: boolean | null;
  nodeVersion: string | null;
  runtimeReady: boolean;
}

function createContainerStore() {
  const { subscribe, set, update } = writable<ContainerState>({
    services: [],
    nodeAvailable: null,
    nodeVersion: null,
    runtimeReady: false,
  });

  return {
    subscribe,
    setNodeStatus(available: boolean, version: string | null) {
      update((s) => ({ ...s, nodeAvailable: available, nodeVersion: version }));
    },
    setRuntimeReady(ready: boolean) {
      update((s) => ({ ...s, runtimeReady: ready }));
    },
    addService(service: DynamicService) {
      update((s) => ({ ...s, services: [...s.services, service] }));
    },
    updateService(id: string, updates: Partial<DynamicService>) {
      update((s) => ({
        ...s,
        services: s.services.map((svc) => (svc.id === id ? { ...svc, ...updates } : svc)),
      }));
    },
    removeService(id: string) {
      update((s) => ({ ...s, services: s.services.filter((svc) => svc.id !== id) }));
    },
    getState(): ContainerState {
      return get({ subscribe });
    },
  };
}

export const containerStore = createContainerStore();
