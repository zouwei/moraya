/**
 * Update Service
 * Checks GitHub releases for new versions, downloads and installs updates.
 */

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import { openPath } from '@tauri-apps/plugin-opener';

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
  update(s => ({ ...s, checkStatus: 'checking', error: null }));

  try {
    const res = await fetch(RELEASES_API, {
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

  try {
    // Use tauriFetch to bypass CORS (GitHub download URLs redirect to a CDN without CORS headers)
    const res = await tauriFetch(info.downloadUrl);
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status}`);
    }

    const contentLength = Number(res.headers.get('content-length')) || info.assetSize;
    const reader = res.body?.getReader();

    if (!reader) {
      // Fallback: no streaming, just download all at once
      const buffer = await res.arrayBuffer();
      await writeFile(info.assetName, new Uint8Array(buffer), {
        baseDir: BaseDirectory.Download,
      });
      update(s => ({ ...s, downloadProgress: 100 }));
    } else {
      // Stream with progress
      const chunks: Uint8Array[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) {
          const progress = Math.round((received / contentLength) * 100);
          update(s => ({ ...s, downloadProgress: progress }));
        }
      }

      // Combine chunks
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      await writeFile(info.assetName, data, {
        baseDir: BaseDirectory.Download,
      });
    }

    update(s => ({ ...s, downloadStatus: 'completed', downloadProgress: 100 }));

    // Open the installer
    const dlDir = await downloadDir();
    const sep = dlDir.endsWith('/') || dlDir.endsWith('\\') ? '' : '/';
    const fullPath = `${dlDir}${sep}${info.assetName}`;
    await openPath(fullPath);

    // Exit the app after a short delay
    setTimeout(() => {
      invoke('exit_app').catch(() => {});
    }, 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Download failed';
    update(s => ({ ...s, downloadStatus: 'error', error: message }));
    throw err;
  }
}
