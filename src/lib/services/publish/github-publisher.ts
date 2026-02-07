/**
 * GitHub Publisher
 * Publishes articles to GitHub repositories using the GitHub Contents API.
 * No git clone needed — lightweight HTTP-based approach.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { GitHubTarget, PublishResult } from './types';
import { renderTemplate, resolveFileName, DEFAULT_FILE_NAME_PATTERN } from './types';

interface GitHubContentsResponse {
  content?: { sha: string };
  sha?: string;
}

/**
 * Parse owner and repo from a GitHub URL.
 * Supports: https://github.com/owner/repo, github.com/owner/repo
 */
function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
  const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

/**
 * Get the SHA of an existing file (needed for updates).
 */
async function getFileSha(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const res = await tauriFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

/**
 * Create or update a file in a GitHub repository.
 */
async function putFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  token: string,
): Promise<{ commitUrl: string }> {
  const sha = await getFileSha(owner, repo, path, branch, token);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const body: Record<string, string> = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch,
  };

  if (sha) {
    body.sha = sha;
  }

  const res = await tauriFetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  return { commitUrl: data.commit?.html_url || '' };
}

/**
 * Publish an article to a GitHub repository.
 */
export async function publishToGitHub(
  target: GitHubTarget,
  variables: Record<string, string>,
  markdownContent: string,
): Promise<PublishResult> {
  try {
    const { owner, repo } = parseGitHubUrl(target.repoUrl);

    // Render front matter
    const frontMatter = renderTemplate(target.frontMatterTemplate, variables);

    // Combine front matter + content
    const fullContent = `${frontMatter}\n\n${markdownContent}`;

    // Build file path using pattern
    const pattern = target.fileNamePattern || DEFAULT_FILE_NAME_PATTERN;
    const fileName = resolveFileName(pattern, variables);
    const articlesDir = target.articlesDir.replace(/\/$/, '');
    const filePath = `${articlesDir}/${fileName}`;

    // Commit message
    const commitMessage = `publish: ${variables.title || variables.slug || 'untitled'}`;

    const { commitUrl } = await putFile(
      owner,
      repo,
      filePath,
      fullContent,
      commitMessage,
      target.branch,
      target.token,
    );

    return {
      success: true,
      targetId: target.id,
      targetName: target.name,
      message: `Published to ${owner}/${repo}`,
      url: commitUrl,
    };
  } catch (error) {
    return {
      success: false,
      targetId: target.id,
      targetName: target.name,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Test connection to a GitHub repository.
 */
export async function testGitHubConnection(target: GitHubTarget): Promise<boolean> {
  try {
    const { owner, repo } = parseGitHubUrl(target.repoUrl);
    const url = `https://api.github.com/repos/${owner}/${repo}`;
    const res = await tauriFetch(url, {
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}
