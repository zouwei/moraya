export type ImageHostProvider =
  | 'smms' | 'imgur' | 'github' | 'gitlab' | 'git-custom' | 'custom'
  | 'qiniu' | 'aliyun-oss' | 'tencent-cos' | 'aws-s3' | 'google-gcs';

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
  // GitLab image hosting fields
  gitlabRepoUrl: string;     // https://gitlab.com/user/images
  gitlabBranch: string;      // main
  gitlabDir: string;         // images/
  gitlabToken: string;       // GitLab PAT
  // Custom Git (Gitea/Forgejo) fields
  gitCustomRepoUrl: string;  // https://git.example.com/user/images
  gitCustomBranch: string;   // main
  gitCustomDir: string;      // images/
  gitCustomToken: string;    // PAT
  // Object storage fields (OSS/S3/COS/GCS/Qiniu)
  ossAccessKey: string;      // AccessKey ID
  ossSecretKey: string;      // SecretKey
  ossBucket: string;         // Bucket name
  ossRegion: string;         // Region
  ossEndpoint: string;       // Custom endpoint (S3-compatible or private)
  ossCdnDomain: string;      // CDN domain (replaces default URL prefix)
  ossPathPrefix: string;     // Path prefix inside bucket (e.g. "images/blog/")
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
  gitlabRepoUrl: '',
  gitlabBranch: 'main',
  gitlabDir: 'images/',
  gitlabToken: '',
  gitCustomRepoUrl: '',
  gitCustomBranch: 'main',
  gitCustomDir: 'images/',
  gitCustomToken: '',
  ossAccessKey: '',
  ossSecretKey: '',
  ossBucket: '',
  ossRegion: '',
  ossEndpoint: '',
  ossCdnDomain: '',
  ossPathPrefix: '',
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
  gitlabRepoUrl: string;
  gitlabBranch: string;
  gitlabDir: string;
  gitlabToken: string;
  gitCustomRepoUrl: string;
  gitCustomBranch: string;
  gitCustomDir: string;
  gitCustomToken: string;
  ossAccessKey: string;
  ossSecretKey: string;
  ossBucket: string;
  ossRegion: string;
  ossEndpoint: string;
  ossCdnDomain: string;
  ossPathPrefix: string;
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
    gitlabRepoUrl: '',
    gitlabBranch: 'main',
    gitlabDir: 'images/',
    gitlabToken: '',
    gitCustomRepoUrl: '',
    gitCustomBranch: 'main',
    gitCustomDir: 'images/',
    gitCustomToken: '',
    ossAccessKey: '',
    ossSecretKey: '',
    ossBucket: '',
    ossRegion: '',
    ossEndpoint: '',
    ossCdnDomain: '',
    ossPathPrefix: '',
  };
}

export function targetToConfig(target: ImageHostTarget): ImageHostConfig {
  const { id: _id, name: _name, ...config } = target;
  return config;
}

/** Whether this provider uses HMAC-signed object storage (Rust command) */
export function isObjectStorageProvider(provider: ImageHostProvider): boolean {
  return provider === 'qiniu' || provider === 'aliyun-oss' ||
         provider === 'tencent-cos' || provider === 'aws-s3' || provider === 'google-gcs';
}

/** Whether this provider uses Git repository hosting */
export function isGitProvider(provider: ImageHostProvider): boolean {
  return provider === 'github' || provider === 'gitlab' || provider === 'git-custom';
}
