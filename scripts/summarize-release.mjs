#!/usr/bin/env node

/**
 * Draft a release commit message from the actual diff, using Claude.
 *
 * Invoked automatically at the end of `pnpm version:bump`, or on its own:
 *   pnpm release:notes            # summarize working-tree changes
 *   pnpm release:notes 1.26.0     # label the draft with an explicit version
 *
 * Design notes:
 *   - The AI step is deliberately OUT of bump-version.mjs. Bumping must stay
 *     deterministic and offline-capable; this only produces a *draft* commit
 *     message and never touches git or the version files.
 *   - No API key to manage: it shells out to the Claude Code binary already on
 *     this machine (PATH, or the VS Code extension's bundled native binary).
 *     If none is found, it degrades to a mechanical summary rather than failing
 *     the release.
 *   - Output goes to `.git/RELEASE_MSG` so it can be used directly:
 *       git commit -F .git/RELEASE_MSG
 */

import { existsSync, readdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
import { homedir } from 'os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Max characters of diff handed to the model — keeps the call fast and cheap. */
const MAX_DIFF_CHARS = 60_000;

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return '';
  }
}

/**
 * Locate a runnable Claude Code binary.
 * Preference: PATH → VS Code extension bundle → the invoking Claude session.
 */
function findClaude() {
  const onPath = sh('command -v claude');
  if (onPath) return onPath;

  // The env var is set when this runs inside a Claude Code session.
  if (process.env.CLAUDE_CODE_EXECPATH && existsSync(process.env.CLAUDE_CODE_EXECPATH)) {
    return process.env.CLAUDE_CODE_EXECPATH;
  }

  // VS Code extension ships a native binary; pick the newest install.
  const extRoot = join(homedir(), '.vscode', 'extensions');
  if (existsSync(extRoot)) {
    const candidates = readdirSync(extRoot)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map((d) => join(extRoot, d, 'resources', 'native-binary', 'claude'))
      .filter((p) => existsSync(p));
    if (candidates.length) return candidates[0];
  }
  return null;
}

/** Collect what changed: staged + unstaged, plus commits since the last tag. */
function collectContext() {
  const lastTag = sh('git describe --tags --abbrev=0');
  const stat = sh('git diff HEAD --stat') || sh('git diff --cached --stat');
  const nameStatus = sh('git diff HEAD --name-status') || sh('git diff --cached --name-status');
  const untracked = sh('git ls-files --others --exclude-standard');
  const commits = lastTag ? sh(`git log ${lastTag}..HEAD --pretty=format:"- %s"`) : '';
  // Full diff, truncated — the model needs the substance, not every line.
  let diff = sh('git diff HEAD') || sh('git diff --cached');
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }
  return { lastTag, stat, nameStatus, untracked, commits, diff, truncated };
}

/** Mechanical fallback when no Claude binary is available. */
function fallbackMessage(version, ctx) {
  const files = ctx.nameStatus.split('\n').filter(Boolean).length;
  return [
    `chore: release v${version}`,
    '',
    `${files} file(s) changed since ${ctx.lastTag || 'the initial commit'}.`,
    '',
    ctx.stat,
  ].join('\n');
}

function buildPrompt(version, ctx) {
  return `You are writing the release commit message for Moraya (a Rust/Tauri + Svelte markdown & Typst editor), version v${version}.

Write a Conventional-Commits message:
- First line: \`chore(release): v${version} — <short summary>\` (<= 72 chars total).
- Blank line, then 3-8 bullet points grouped by area (editor / core / rust / ui / fix).
- Each bullet states WHAT changed and WHY it matters to a user or maintainer. Prefer the user-visible effect over file names.
- Mention notable bug fixes explicitly, including the symptom that was fixed.
- Chinese for prose is fine; keep code identifiers, paths and conventional-commit keywords in English.
- Output ONLY the commit message. No preamble, no code fences, no commentary.

${ctx.commits ? `Commits since ${ctx.lastTag}:\n${ctx.commits}\n` : ''}
Changed files:
${ctx.nameStatus || '(none)'}

${ctx.untracked ? `New untracked files:\n${ctx.untracked}\n` : ''}
Diffstat:
${ctx.stat || '(none)'}

Diff${ctx.truncated ? ' (truncated)' : ''}:
${ctx.diff || '(empty)'}`;
}

function main() {
  const version = process.argv[2] || (() => {
    try {
      return JSON.parse(sh('cat package.json') || '{}').version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();

  const ctx = collectContext();
  if (!ctx.nameStatus && !ctx.untracked) {
    console.log('\nNo working-tree changes to summarize — skipping release notes.');
    return;
  }

  const outFile = join(root, '.git', 'RELEASE_MSG');
  const claude = findClaude();

  let message;
  if (!claude) {
    console.log('\n⚠ Claude Code binary not found — writing a mechanical summary instead.');
    message = fallbackMessage(version, ctx);
  } else {
    console.log(`\nDrafting release notes with Claude (${claude.includes('.vscode') ? 'VS Code bundle' : claude})…`);
    try {
      message = execFileSync(claude, ['-p', '--model', 'sonnet'], {
        cwd: root,
        input: buildPrompt(version, ctx),
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      // Strip a stray code fence if the model added one anyway.
      message = message.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      if (!message) throw new Error('empty response');
    } catch (err) {
      console.log(`⚠ Claude call failed (${err.message}) — falling back to a mechanical summary.`);
      message = fallbackMessage(version, ctx);
    }
  }

  writeFileSync(outFile, message + '\n');
  console.log('\n' + '─'.repeat(60));
  console.log(message);
  console.log('─'.repeat(60));
  console.log(`\nDraft saved to .git/RELEASE_MSG — review it, then:`);
  console.log(`  git add -A && git commit -F .git/RELEASE_MSG`);
  console.log(`  git tag v${version} && git push origin main --tags`);
}

main();
