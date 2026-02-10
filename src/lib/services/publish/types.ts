/**
 * Publish Target Type Definitions
 * Supports GitHub Repository and Custom API publishing targets.
 */

/** RSS feed configuration for a publish target */
export interface RSSConfig {
  enabled: boolean;
  feedPath: string;           // e.g., "feed.xml"
  siteUrl: string;            // e.g., "https://myblog.com"
  feedTitle: string;
  feedDescription: string;
  language: string;           // e.g., "en" or "zh-CN"
  authorName: string;
  maxItems: number;           // default: 20
  includeFullContent: boolean; // include content:encoded in feed
}

export const DEFAULT_RSS_CONFIG: RSSConfig = {
  enabled: false,
  feedPath: 'feed.xml',
  siteUrl: '',
  feedTitle: '',
  feedDescription: '',
  language: 'en',
  authorName: '',
  maxItems: 20,
  includeFullContent: true,
};

export interface GitHubTarget {
  type: 'github';
  id: string;
  name: string;
  repoUrl: string;         // https://github.com/user/blog
  branch: string;           // main
  articlesDir: string;      // content/posts/
  imagesDir: string;        // static/images/
  token: string;            // GitHub PAT
  frontMatterPreset: string; // 'hugo' | 'hexo' | 'astro' | 'custom'
  frontMatterTemplate: string;
  fileNamePattern: string;  // e.g. '{{date}}-{{slug}}'
  rss?: RSSConfig;
}

export interface CustomAPIRSSConfig {
  enabled: boolean;
  feedEndpoint: string;     // POST endpoint for RSS update
}

export interface CustomAPITarget {
  type: 'custom-api';
  id: string;
  name: string;
  endpoint: string;         // https://my-server.com/api/articles
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  bodyTemplate: string;     // JSON template with {{variables}}
  fileNamePattern: string;  // e.g. '{{date}}-{{slug}}'
  rss?: CustomAPIRSSConfig;
}

export type PublishTarget = GitHubTarget | CustomAPITarget;

/** Template variables available for front matter and body templates */
export const TEMPLATE_VARIABLES = [
  '{{title}}',
  '{{date}}',
  '{{tags}}',
  '{{description}}',
  '{{slug}}',
  '{{cover}}',
  '{{excerpt}}',
  '{{content}}',
] as const;

/** File name pattern presets */
export const FILE_NAME_PRESETS: Record<string, string> = {
  simple: '{{filename}}',
  dateSlug: '{{date}}-{{slug}}',
  dateFilename: '{{date}}-{{filename}}',
  yearMonth: '{{year}}/{{month}}/{{slug}}',
};

export const DEFAULT_FILE_NAME_PATTERN = FILE_NAME_PRESETS.dateSlug;

/** Front matter presets for popular static site generators */
export const FRONT_MATTER_PRESETS: Record<string, string> = {
  hugo: `---
title: "{{title}}"
date: {{date}}
description: "{{description}}"
tags: [{{tags}}]
cover: "{{cover}}"
slug: "{{slug}}"
---`,
  hexo: `---
title: {{title}}
date: {{date}}
tags:
{{tags}}
description: {{description}}
cover: {{cover}}
---`,
  astro: `---
title: "{{title}}"
pubDate: {{date}}
description: "{{description}}"
tags: [{{tags}}]
heroImage: "{{cover}}"
slug: "{{slug}}"
---`,
};

/** Result of a publish operation */
export interface PublishResult {
  success: boolean;
  targetId: string;
  targetName: string;
  message: string;
  url?: string;  // e.g., GitHub commit URL
}

/**
 * Render a template string by replacing {{variable}} placeholders.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Resolve a file name from a pattern and variables.
 * Extension is always .md. {{slug}} falls back to {{filename}} if empty.
 */
export function resolveFileName(
  pattern: string,
  variables: Record<string, string>,
): string {
  const now = new Date();
  const date = variables.date || now.toISOString().slice(0, 10);
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const day = date.slice(8, 10);
  const slug = variables.slug || variables.filename || 'untitled';
  const filename = variables.filename || variables.slug || 'untitled';
  const title = variables.title || filename;

  const vars: Record<string, string> = {
    ...variables,
    date,
    year,
    month,
    day,
    slug,
    filename,
    title,
  };

  let result = renderTemplate(pattern, vars);
  // Sanitize each path segment (but preserve '/' for subdirectories)
  result = result.split('/').map(seg =>
    seg.replace(/[<>:"\\|?*]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  ).filter(Boolean).join('/');

  return result ? `${result}.md` : 'untitled.md';
}

/**
 * Generate a unique ID for a new publish target.
 */
export function generateTargetId(): string {
  return `target_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a default GitHub target.
 */
export function createDefaultGitHubTarget(): GitHubTarget {
  return {
    type: 'github',
    id: generateTargetId(),
    name: '',
    repoUrl: '',
    branch: 'main',
    articlesDir: 'content/posts/',
    imagesDir: 'static/images/',
    token: '',
    frontMatterPreset: 'hugo',
    frontMatterTemplate: FRONT_MATTER_PRESETS.hugo,
    fileNamePattern: DEFAULT_FILE_NAME_PATTERN,
    rss: { ...DEFAULT_RSS_CONFIG },
  };
}

/**
 * Create a default Custom API target.
 */
export function createDefaultCustomAPITarget(): CustomAPITarget {
  return {
    type: 'custom-api',
    id: generateTargetId(),
    name: '',
    endpoint: '',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    bodyTemplate: '{\n  "title": "{{title}}",\n  "content": "{{content}}",\n  "tags": "{{tags}}"\n}',
    fileNamePattern: DEFAULT_FILE_NAME_PATTERN,
    rss: { enabled: false, feedEndpoint: '' },
  };
}
