/**
 * Update Service
 * Checks GitHub releases for new versions, downloads and installs updates.
 */

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// --- Types ---

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  downloadUrl: string | null;
  assetName: string | null;
  assetSize: number;
}

export type UpdateCheckStatus = 'idle' | 'checking' | 'available' | 'latest' | 'error';
export type DownloadStatus = 'idle' | 'downloading' | 'completed' | 'error';

interface UpdateState {
  checkStatus: UpdateCheckStatus;
  downloadStatus: DownloadStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number;
  error: string | null;
}

interface PlatformInfo {
  os: string;
  arch: string;
}

// --- Constants ---

const GITHUB_REPO = 'zouwei/moraya';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

// --- Store ---

const DEFAULT_STATE: UpdateState = {
  checkStatus: 'idle',
  downloadStatus: 'idle',
  updateInfo: null,
  downloadProgress: 0,
  error: null,
};

const { subscribe, set, update } = writable<UpdateState>(DEFAULT_STATE);

export const updateStore = {
  subscribe,
  getState() {
    return get({ subscribe });
  },
  reset() {
    set(DEFAULT_STATE);
  },
};

// --- Semver Comparison ---

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// --- Platform Asset Matching ---

function findMatchingAsset(
  assets: ReleaseAsset[],
  platform: PlatformInfo,
): ReleaseAsset | null {
  const { os, arch } = platform;

  // Map Rust arch names to Tauri asset naming conventions
  const archMap: Record<string, string[]> = {
    aarch64: ['aarch64', 'arm64'],
    x86_64: ['x64', 'x86_64', 'amd64'],
  };

  const archNames = archMap[arch] || [arch];

  // Define extension preferences per OS
  const extPrefs: Record<string, string[]> = {
    macos: ['.dmg'],
    windows: ['-setup.exe', '.msi'],
    linux: ['.AppImage', '.deb'],
  };

  const exts = extPrefs[os] || [];

  // Try exact match: extension + arch
  for (const ext of exts) {
    for (const archName of archNames) {
      const match = assets.find(
        a => a.name.includes(archName) && a.name.endsWith(ext),
      );
      if (match) return match;
    }
  }

  // Fallback: any asset with the right extension
  for (const ext of exts) {
    const match = assets.find(a => a.name.endsWith(ext));
    if (match) return match;
  }

  return null;
}

// --- Date Utilities ---

export function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shouldCheckToday(lastCheckDate: string | null): boolean {
  if (!lastCheckDate) return true;
  return lastCheckDate !== getTodayDateString();
}

// --- Core Functions ---

export async function checkForUpdate(): Promise<UpdateInfo> {
  update(s => ({ ...s, checkStatus: 'checking', downloadStatus: 'idle', downloadProgress: 0, error: null }));

  try {
    const res = await tauriFetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub API rate limit exceeded. Please try again later.');
    }

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status}`);
    }

    const release: GitHubRelease = await res.json();
    const latestVersion = release.tag_name.replace(/^v/, '');
    const currentVersion = __APP_VERSION__;

    const platform: PlatformInfo = await invoke('get_platform_info');
    const asset = findMatchingAsset(release.assets, platform);

    const info: UpdateInfo = {
      available: compareSemver(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
      releaseNotes: release.body || '',
      releaseUrl: release.html_url,
      publishedAt: release.published_at,
      downloadUrl: asset?.browser_download_url || null,
      assetName: asset?.name || null,
      assetSize: asset?.size || 0,
    };

    update(s => ({
      ...s,
      checkStatus: info.available ? 'available' : 'latest',
      updateInfo: info,
    }));

    return info;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    update(s => ({ ...s, checkStatus: 'error', error: message }));
    throw err;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { formatBytes };

export async function downloadAndInstall(): Promise<void> {
  const state = get({ subscribe });
  const info = state.updateInfo;
  if (!info?.downloadUrl || !info.assetName) {
    throw new Error('No download URL available');
  }

  update(s => ({ ...s, downloadStatus: 'downloading', downloadProgress: 0 }));

  // Listen for progress events from Rust
  const unlisten = await listen<{ received: number; total: number; progress: number }>(
    'download-progress',
    (event) => {
      update(s => ({ ...s, downloadProgress: event.payload.progress }));
    },
  );

  try {
    // Download entirely in Rust — reqwest streams directly to disk,
    // no IPC binary transfer needed.
    const fullPath: string = await invoke('download_update', {
      url: info.downloadUrl,
      filename: info.assetName,
    });

    update(s => ({ ...s, downloadStatus: 'completed', downloadProgress: 100 }));
  } catch (err) {
    // Tauri invoke errors are strings, not Error objects
    const message = err instanceof Error ? err.message : String(err) || 'Download failed';
    update(s => ({ ...s, downloadStatus: 'error', error: message }));
    throw err;
  } finally {
    unlisten();
  }
}
