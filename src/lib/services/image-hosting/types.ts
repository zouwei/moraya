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
