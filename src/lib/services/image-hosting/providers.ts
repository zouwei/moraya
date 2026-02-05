import type { ImageHostConfig, UploadResult } from './types';

/**
 * Generate a timestamped filename to avoid conflicts.
 * e.g. "20260205-143052-photo.png"
 */
function timestampedName(originalName: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1-$2');
  const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '.png';
  const base = originalName.includes('.')
    ? originalName.slice(0, originalName.lastIndexOf('.')).replace(/[^a-zA-Z0-9_-]/g, '')
    : 'image';
  return `${ts}-${base || 'image'}${ext}`;
}

/**
 * Parse owner and repo from a GitHub URL.
 */
function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
  const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

async function uploadToGitHub(blob: Blob, config: ImageHostConfig): Promise<UploadResult> {
  if (!config.githubRepoUrl || !config.githubToken) {
    throw new Error('GitHub image hosting is not configured');
  }

  const { owner, repo } = parseGitHubUrl(config.githubRepoUrl);
  const branch = config.githubBranch || 'main';
  const dir = (config.githubDir || 'images/').replace(/\/$/, '');

  // Generate timestamped filename
  const fileName = timestampedName((blob as File).name || 'image.png');
  const filePath = `${dir}/${fileName}`;

  // Read blob as base64
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Content = btoa(binary);

  // Upload via GitHub Contents API
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `upload: ${fileName}`,
      content: base64Content,
      branch,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub upload failed (${res.status}): ${errBody}`);
  }

  // Build access URL based on CDN mode
  let imageUrl: string;
  if (config.githubCdn === 'jsdelivr') {
    imageUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filePath}`;
  } else {
    imageUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  }

  return { url: imageUrl };
}

async function uploadToSmms(blob: Blob, config: ImageHostConfig): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('smfile', blob, 'image.png');

  const res = await fetch('https://sm.ms/api/v2/upload', {
    method: 'POST',
    headers: {
      Authorization: config.apiToken,
    },
    body: formData,
  });

  const json = await res.json();
  if (!json.success && json.code !== 'image_repeated') {
    throw new Error(json.message || 'SM.MS upload failed');
  }

  const data = json.code === 'image_repeated' ? json.images : json.data;
  return {
    url: data.url,
    deleteUrl: data.delete,
  };
}

async function uploadToImgur(blob: Blob, config: ImageHostConfig): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('image', blob);

  const res = await fetch('https://api.imgur.com/3/image', {
    method: 'POST',
    headers: {
      Authorization: `Client-ID ${config.apiToken}`,
    },
    body: formData,
  });

  const json = await res.json();
  if (!json.success) {
    throw new Error(json.data?.error || 'Imgur upload failed');
  }

  return {
    url: json.data.link,
    deleteUrl: json.data.deletehash
      ? `https://api.imgur.com/3/image/${json.data.deletehash}`
      : undefined,
  };
}

async function uploadToCustom(blob: Blob, config: ImageHostConfig): Promise<UploadResult> {
  if (!config.customEndpoint) {
    throw new Error('Custom endpoint is not configured');
  }

  const formData = new FormData();
  formData.append('file', blob, 'image.png');

  let headers: Record<string, string> = {};
  if (config.apiToken) {
    headers['Authorization'] = `Bearer ${config.apiToken}`;
  }
  if (config.customHeaders) {
    try {
      const parsed = JSON.parse(config.customHeaders);
      headers = { ...headers, ...parsed };
    } catch {
      // Invalid JSON headers, ignore
    }
  }

  const res = await fetch(config.customEndpoint, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();

  // Try common response formats
  const url =
    json.url ||
    json.data?.url ||
    json.data?.link ||
    json.src ||
    json.image?.url ||
    json.result?.url;

  if (!url) {
    throw new Error('Could not find image URL in response');
  }

  return { url };
}

export const providers: Record<
  string,
  (blob: Blob, config: ImageHostConfig) => Promise<UploadResult>
> = {
  smms: uploadToSmms,
  imgur: uploadToImgur,
  github: uploadToGitHub,
  custom: uploadToCustom,
};
