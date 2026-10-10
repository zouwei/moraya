export type ImageHostProvider =
  | 'picora'
  | 'smms' | 'imgur' | 'github' | 'gitlab' | 'git-custom' | 'custom'
  | 'qiniu' | 'aliyun-oss' | 'tencent-cos' | 'aws-s3' | 'google-gcs';

/** Default Picora SaaS endpoints. Editable per target. */
export const PICORA_DEFAULT_API_URL = 'https://api.picora.me/v1/images';
export const PICORA_DEFAULT_IMG_DOMAIN = 'https://media.picora.me';
export const PICORA_DEFAULT_API_BASE = 'https://api.picora.me';

export type GitHubCdnMode = 'raw' | 'jsdelivr';

export interface ImageHostConfig {
  provider: ImageHostProvider;
  apiToken: string;
  customEndpoint: string;
  customHeaders: string; // JSON string
  customUrlTemplate: string; // URL template with {id}/{storageKey}/{filename}/{url} placeholders
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
  // Picora SaaS image host
  picoraApiUrl: string;      // Upload endpoint (default https://api.picora.me/v1/images)
  picoraApiKey: string;      // Bearer token (sk_live_...)
  picoraImgDomain: string;   // Public CDN base (default https://media.picora.me)
  picoraUserEmail: string;   // Display-only, populated by import flow
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
  customUrlTemplate: '',
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
  picoraApiUrl: PICORA_DEFAULT_API_URL,
  picoraApiKey: '',
  picoraImgDomain: PICORA_DEFAULT_IMG_DOMAIN,
  picoraUserEmail: '',
};

export interface ImageHostTarget {
  id: string;
  name: string;
  provider: ImageHostProvider;
  apiToken: string;
  customEndpoint: string;
  customHeaders: string;
  customUrlTemplate: string;
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
  picoraApiUrl: string;
  /**
   * Legacy plaintext field. As of v0.69.0 the actual key is stored in the OS
   * Keychain under `picora-api-key:{id}` and this field is cleared after
   * one-shot migration. Reading code MUST go through `getPicoraApiKey()` in
   * `$lib/services/picora/credentials` rather than reading the field directly.
   *
   * @deprecated since v0.69.0 — slated for full removal in v0.75.0.
   */
  picoraApiKey: string;
  picoraImgDomain: string;
  picoraUserEmail: string;
  /** True after the v0.69.0 migration moved `picoraApiKey` to the Keychain. */
  picoraKeyMigratedV069?: boolean;
  /**
   * v0.69.0 Phase 2 — when present, credential resolution goes through the
   * OAuth Device Flow path (`picora_oauth_get_token`) instead of the legacy
   * api-key path. Set by v0.66.0's "Connect Picora" onboarding after a
   * successful device-flow login.
   *
   * Mutually exclusive with `picoraApiKey` in practice — the resolver prefers
   * the OAuth ref when both are present.
   */
  picoraAuthRef?: PicoraAuthRef;
  /** Set by Picora import flow; affects sort order and badge rendering. */
  featured?: boolean;
  /** Unix ms when this target was imported from Picora; display-only. */
  picoraImportedAt?: number;
}

/** Whether the default target has enough settings to attempt an upload. */
export function isImageHostTargetConfigured(target: ImageHostTarget | null): boolean {
  if (!target) return false;
  switch (target.provider) {
    case 'picora':
      return !!(target.picoraApiUrl && (target.picoraApiKey || target.picoraAuthRef || target.picoraKeyMigratedV069));
    case 'smms':
    case 'imgur':
      return !!target.apiToken;
    case 'github':
      return !!(target.githubRepoUrl && target.githubToken);
    case 'gitlab':
      return !!(target.gitlabRepoUrl && target.gitlabToken);
    case 'git-custom':
      return !!(target.gitCustomRepoUrl && target.gitCustomToken);
    case 'custom':
      return !!target.customEndpoint;
    case 'qiniu':
      return !!(target.ossAccessKey && target.ossSecretKey && target.ossBucket && target.ossRegion && target.ossCdnDomain);
    default:
      return !!(target.ossAccessKey && target.ossSecretKey && target.ossBucket && target.ossRegion);
  }
}

/**
 * Reference to a Picora authentication credential. v0.69.0 Phase 2 ships
 * with `oauth` only; future kinds (e.g. `api-key`) can be added when needed.
 *
 * Storage: tokens live in OS Keychain under `picora-token:{accountId}`
 * (see `src-tauri/src/commands/picora_oauth.rs`); this struct holds only
 * the lookup key.
 */
export type PicoraAuthRef = { kind: 'oauth'; accountId: string };

export function generateImageHostTargetId(): string {
  return `imghost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultImageHostTarget(provider: ImageHostProvider): ImageHostTarget {
  return {
    id: generateImageHostTargetId(),
    name: provider === 'picora' ? 'Picora' : '',
    provider,
    apiToken: '',
    customEndpoint: '',
    customHeaders: '',
    customUrlTemplate: '',
    autoUpload: provider === 'picora',
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
    picoraApiUrl: PICORA_DEFAULT_API_URL,
    picoraApiKey: '',
    picoraImgDomain: PICORA_DEFAULT_IMG_DOMAIN,
    picoraUserEmail: '',
  };
}

export function targetToConfig(target: ImageHostTarget): ImageHostConfig {
  const { id: _id, name: _name, featured: _f, picoraImportedAt: _t, ...config } = target;
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
