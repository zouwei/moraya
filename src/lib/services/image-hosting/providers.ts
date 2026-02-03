import type { ImageHostConfig, UploadResult } from './types';

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
  custom: uploadToCustom,
};
