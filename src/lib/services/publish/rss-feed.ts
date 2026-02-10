/**
 * RSS Feed Generator & Parser
 * Generates RSS 2.0 XML and parses existing feeds.
 * Zero dependencies — uses template literals and regex.
 */

import type { RSSConfig } from './types';

export interface RSSItem {
  title: string;
  link: string;
  description: string;   // excerpt
  pubDate: string;        // RFC 2822 date
  guid: string;           // unique ID (typically the article URL)
  contentEncoded?: string; // full HTML content
  author?: string;
}

/** Escape special XML characters. */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Unescape XML entities back to plain text. */
function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Wrap content in CDATA section. */
function wrapCDATA(str: string): string {
  // Escape any occurrences of ]]> inside content
  const safe = str.replace(/\]\]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/**
 * Convert a Date to RFC 2822 format as required by RSS 2.0.
 * e.g., "Mon, 10 Feb 2026 12:00:00 +0000"
 */
export function toRFC2822Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/**
 * Build a complete RSS 2.0 XML string from config and items.
 */
export function buildRSSFeed(config: RSSConfig, items: RSSItem[]): string {
  const feedUrl = `${config.siteUrl.replace(/\/$/, '')}/${config.feedPath}`;

  const itemsXml = items.map(item => {
    let xml = `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <description>${escapeXml(item.description)}</description>
      <pubDate>${item.pubDate}</pubDate>
      <guid isPermaLink="true">${escapeXml(item.guid)}</guid>`;
    if (item.author) {
      xml += `\n      <author>${escapeXml(item.author)}</author>`;
    }
    if (item.contentEncoded) {
      xml += `\n      <content:encoded>${wrapCDATA(item.contentEncoded)}</content:encoded>`;
    }
    xml += '\n    </item>';
    return xml;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(config.feedTitle)}</title>
    <link>${escapeXml(config.siteUrl)}</link>
    <description>${escapeXml(config.feedDescription)}</description>
    <language>${escapeXml(config.language)}</language>
    <lastBuildDate>${toRFC2822Date(new Date())}</lastBuildDate>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <generator>Moraya</generator>
${itemsXml}
  </channel>
</rss>`;
}

/** Extract text content from a simple XML tag. */
function extractTag(xml: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`);
  const match = xml.match(regex);
  return match ? unescapeXml(match[1].trim()) : '';
}

/** Extract CDATA content from a tag. Falls back to regular tag extraction. */
function extractCDATA(xml: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escapedTag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escapedTag}>`);
  const match = xml.match(regex);
  if (match) return match[1];
  return extractTag(xml, tag);
}

/**
 * Parse RSS items from an existing feed XML string.
 * Uses regex since we only parse Moraya-generated feeds.
 */
export function parseRSSItems(xml: string): RSSItem[] {
  const items: RSSItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      description: extractTag(block, 'description'),
      pubDate: extractTag(block, 'pubDate'),
      guid: extractTag(block, 'guid'),
      contentEncoded: extractCDATA(block, 'content:encoded') || undefined,
      author: extractTag(block, 'author') || undefined,
    });
  }
  return items;
}

/**
 * Insert or update an RSS item by guid. Sorts newest-first, trims to maxItems.
 */
export function upsertRSSItem(
  existingItems: RSSItem[],
  newItem: RSSItem,
  maxItems: number,
): RSSItem[] {
  // Remove existing item with same guid (if any)
  const filtered = existingItems.filter(item => item.guid !== newItem.guid);
  // Add new item at front (newest first)
  const items = [newItem, ...filtered];
  // Parse RFC 2822 dates for sorting
  items.sort((a, b) => {
    const da = new Date(a.pubDate).getTime() || 0;
    const db = new Date(b.pubDate).getTime() || 0;
    return db - da;
  });
  // Trim to maxItems
  return items.slice(0, maxItems);
}
