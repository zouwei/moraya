export type ImageHostProvider = 'smms' | 'imgur' | 'github' | 'custom';

export type GitHubCdnMode = 'raw' | 'jsdelivr';

export interface ImageHostConfig {
  provider: ImageHostProvider;
  apiToken: string;
  customEndpoint: string;
  customHeaders: string; // JSON string
  autoUpload: boolean;
  // GitHub image hosting fields
  githubRepoUrl: string;     // https://github.com/user/images
  githubBranch: string;      // main
  githubDir: string;         // images/
  githubToken: string;       // GitHub PAT
  githubCdn: GitHubCdnMode; // 'raw' | 'jsdelivr'
}

export interface UploadResult {
  url: string;
  deleteUrl?: string;
}

export const DEFAULT_IMAGE_HOST_CONFIG: ImageHostConfig = {
  provider: 'custom',
  apiToken: '',
  customEndpoint: '',
  customHeaders: '',
  autoUpload: false,
  githubRepoUrl: '',
  githubBranch: 'main',
  githubDir: 'images/',
  githubToken: '',
  githubCdn: 'raw',
};

export interface ImageHostTarget {
  id: string;
  name: string;
  provider: ImageHostProvider;
  apiToken: string;
  customEndpoint: string;
  customHeaders: string;
  autoUpload: boolean;
  githubRepoUrl: string;
  githubBranch: string;
  githubDir: string;
  githubToken: string;
  githubCdn: GitHubCdnMode;
}

export function generateImageHostTargetId(): string {
  return `imghost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultImageHostTarget(provider: ImageHostProvider): ImageHostTarget {
  return {
    id: generateImageHostTargetId(),
    name: '',
    provider,
    apiToken: '',
    customEndpoint: '',
    customHeaders: '',
    autoUpload: false,
    githubRepoUrl: '',
    githubBranch: 'main',
    githubDir: 'images/',
    githubToken: '',
    githubCdn: 'raw',
  };
}

export function targetToConfig(target: ImageHostTarget): ImageHostConfig {
  const { id: _id, name: _name, ...config } = target;
  return config;
}
