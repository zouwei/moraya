/**
 * RSS Publisher
 * Orchestrates RSS feed updates when publishing articles.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { GitHubTarget, CustomAPITarget } from './types';
import { parseGitHubUrl, getFileContent, putFile } from './github-publisher';
import { buildRSSFeed, parseRSSItems, upsertRSSItem, toRFC2822Date } from './rss-feed';
import type { RSSItem } from './rss-feed';
import { markdownToHtmlBody } from '$lib/services/export-service';

/**
 * Update the RSS feed in a GitHub repository after publishing an article.
 * Non-fatal: caller should catch errors and show a warning toast.
 */
export async function updateGitHubRSSFeed(
  target: GitHubTarget,
  variables: Record<string, string>,
  markdownContent: string,
): Promise<void> {
  const rss = target.rss;
  if (!rss?.enabled || !rss.siteUrl) return;

  const { owner, repo } = parseGitHubUrl(target.repoUrl);
  const feedPath = rss.feedPath || 'feed.xml';

  // Fetch existing feed.xml (may not exist yet)
  const existingXml = await getFileContent(owner, repo, feedPath, target.branch, target.token);
  const existingItems = existingXml ? parseRSSItems(existingXml) : [];

  // Build article URL
  const siteUrl = rss.siteUrl.replace(/\/$/, '');
  const slug = variables.slug || 'untitled';
  const articleUrl = `${siteUrl}/${slug}`;

  // Build new RSS item
  const newItem: RSSItem = {
    title: variables.title || 'Untitled',
    link: articleUrl,
    description: variables.excerpt || variables.description || '',
    pubDate: toRFC2822Date(new Date()),
    guid: articleUrl,
    author: rss.authorName || undefined,
    contentEncoded: rss.includeFullContent ? markdownToHtmlBody(markdownContent) : undefined,
  };

  // Upsert and trim
  const items = upsertRSSItem(existingItems, newItem, rss.maxItems || 20);

  // Build and push feed
  const feedXml = buildRSSFeed(rss, items);
  await putFile(
    owner,
    repo,
    feedPath,
    feedXml,
    `rss: update feed (${variables.title || slug})`,
    target.branch,
    target.token,
  );
}

/**
 * Update RSS feed via a Custom API endpoint.
 * POSTs the article data as JSON; the server handles feed generation.
 */
export async function updateCustomAPIRSSFeed(
  target: CustomAPITarget,
  variables: Record<string, string>,
  markdownContent: string,
): Promise<void> {
  const rss = target.rss;
  if (!rss?.enabled || !rss.feedEndpoint) return;

  const body = JSON.stringify({
    title: variables.title,
    slug: variables.slug,
    description: variables.description,
    excerpt: variables.excerpt,
    tags: variables.tags,
    content: markdownContent,
    date: variables.date,
  });

  const res = await tauriFetch(rss.feedEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...target.headers,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`RSS API error (${res.status}): ${errBody}`);
  }
}
