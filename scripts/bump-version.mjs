#!/usr/bin/env node

/**
 * Bump version across all config files and optionally create a git tag.
 *
 * Usage:
 *   pnpm version:bump 0.2.0        # Set explicit version
 *   pnpm version:bump patch         # 0.1.0 → 0.1.1
 *   pnpm version:bump minor         # 0.1.0 → 0.2.0
 *   pnpm version:bump major         # 0.1.0 → 1.0.0
 *
 * Files updated:
 *   - package.json
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *
 * Before touching any of those, it also syncs the `@moraya/core` dependency
 * (see `syncCoreDependency`): if it's still on the local vendored-tarball
 * bridge (`file:./vendor/*.tgz`, per CLAUDE.md §"External Shared Markdown
 * Core"), this checks whether that exact version is published on npm and, if
 * so, switches package.json to the real registry range (`^X.Y.Z`) and runs
 * `pnpm install` — so a release built from the bumped version never ships
 * the release-gate violation `scripts/check-core-dep.mjs` would otherwise
 * catch at push time. If the vendored version isn't published yet, this
 * fails fast (before any file is modified) with the same runbook
 * `check-core-dep.mjs` prints, since there's nothing to switch to.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const files = {
  package: resolve(root, 'package.json'),
  tauri: resolve(root, 'src-tauri/tauri.conf.json'),
  cargo: resolve(root, 'src-tauri/Cargo.toml'),
};

const CORE_PKG = '@moraya/core';

/**
 * Pick the most useful single line out of a failed npm command's output.
 * `npm view` on a missing version prints its real reason (`npm error 404 ...`)
 * AFTER unrelated `npm warn ...` lines (e.g. deprecated config warnings) — a
 * naive "first line" grab surfaces the warning instead of the actual error.
 * Prefers the first `npm error` line; falls back to the first non-warning,
 * non-empty line; falls back to the raw message if nothing else matches.
 */
function extractNpmErrorLine(e) {
  const text = String(e.stderr || e.stdout || e.message || '').trim();
  if (!text) return '(no output)';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => /^npm error/i.test(l));
  if (errorLine) return errorLine;
  const nonWarning = lines.find((l) => !/^npm warn/i.test(l));
  return nonWarning || lines[0];
}

/**
 * If `@moraya/core` is on the vendored-tarball bridge, verify the vendored
 * version is published on npm and switch the dependency to a registry range
 * (`pnpm install` to refresh the lockfile). No-op if it's already a registry
 * range. Fails the whole bump (exit 1, no files touched) if the vendored
 * version isn't published yet, or if the spec is some other non-registry
 * source (file:../sibling, link:, workspace:, git) that should never reach
 * a release per CLAUDE.md's hard rules.
 */
function syncCoreDependency() {
  const pkg = readJSON(files.package);
  const spec = pkg.dependencies?.[CORE_PKG] ?? pkg.devDependencies?.[CORE_PKG];
  if (!spec) return; // this repo doesn't depend on core — nothing to guard

  const vendoredMatch = spec.match(/^file:(?:\.\/)?vendor\/([^/]+)\.tgz$/);
  if (!vendoredMatch) {
    if (/^(file:|link:|workspace:|git\+|git:|https?:)/.test(spec)) {
      console.error(
        `\n${CORE_PKG} points at a non-registry source ("${spec}").\n` +
          `  Only an npm range (^X.Y.Z) or a frozen ./vendor/*.tgz bridge are allowed.\n` +
          `  Never allowed: file:../sibling, link:, workspace:, git URLs.\n`,
      );
      process.exit(1);
    }
    console.log(`${CORE_PKG}: already on a registry range ("${spec}") — nothing to sync.\n`);
    return;
  }

  const versionMatch = vendoredMatch[1].match(/^moraya-core-([\d.]+(?:-[\w.]+)?)$/);
  const vendoredVersion = versionMatch ? versionMatch[1] : null;
  if (!vendoredVersion) {
    console.error(`\nCould not parse a version out of vendored tarball name "${vendoredMatch[1]}.tgz".\n`);
    process.exit(1);
  }

  console.log(`${CORE_PKG}: on vendored bridge (v${vendoredVersion}) — checking npm...`);
  try {
    execSync(`npm view "${CORE_PKG}@${vendoredVersion}" version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (e) {
    console.error(
      `\n${CORE_PKG}@${vendoredVersion} is not published on npm yet (or the registry is unreachable).\n` +
        `  Runbook:\n` +
        `    1. In moraya-core:  pnpm version:bump <patch|minor|major>\n` +
        `                        git commit + tag + push  → publishes to npm\n` +
        `                        (or: pnpm release <patch|minor|major> to do this + propagate automatically)\n` +
        `    2. Wait until  npm view ${CORE_PKG}@${vendoredVersion} version  succeeds\n` +
        `    3. Re-run this command — it will auto-switch the dependency once published.\n` +
        `  npm said: ${extractNpmErrorLine(e)}\n`,
    );
    process.exit(1);
  }

  pkg.dependencies[CORE_PKG] = `^${vendoredVersion}`;
  writeJSON(files.package, pkg);
  console.log(`  ✓ ${CORE_PKG} → "^${vendoredVersion}" (published, switched off the vendor bridge)`);
  console.log('  Running pnpm install to refresh the lockfile...');
  execSync('pnpm install', { cwd: root, stdio: 'inherit' });
  console.log('  ✓ pnpm-lock.yaml\n');
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function getCurrentVersion() {
  return readJSON(files.package).version;
}

function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: return type; // explicit version string
  }
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error(`Invalid version: "${version}". Expected format: x.y.z or x.y.z-beta.1`);
    process.exit(1);
  }
}

// --- Main ---

const input = process.argv[2];
if (!input) {
  console.error('Usage: bump-version.mjs <patch|minor|major|x.y.z>');
  process.exit(1);
}

const current = getCurrentVersion();
const next = bumpVersion(current, input);
validateVersion(next);

console.log(`Bumping version: ${current} → ${next}\n`);

// 0a. Sync @moraya/core off the vendor bridge first — fail fast, before
// touching any of this repo's own version files, if core isn't published yet.
syncCoreDependency();

// 0b. Sync renderer plugin versions (if feature exists)
const syncScript = resolve(__dirname, 'sync-renderer-plugins.mjs');
if (existsSync(syncScript)) {
  console.log('Syncing renderer plugin versions...');
  try {
    execSync(`node ${syncScript}`, { stdio: 'inherit' });
    console.log('  ✓ renderer-versions.json\n');
  } catch {
    console.warn('  ⚠ Plugin sync failed (non-fatal), continuing...\n');
  }
}

// 1. package.json
const pkg = readJSON(files.package);
pkg.version = next;
writeJSON(files.package, pkg);
console.log(`  ✓ package.json`);

// 2. tauri.conf.json
const tauri = readJSON(files.tauri);
tauri.version = next;
writeJSON(files.tauri, tauri);
console.log(`  ✓ src-tauri/tauri.conf.json`);

// 3. Cargo.toml (regex replace)
let cargo = readFileSync(files.cargo, 'utf-8');
cargo = cargo.replace(
  /^(version\s*=\s*")[\d.]+(-[\w.]+)?(")/m,
  `$1${next}$3`
);
writeFileSync(files.cargo, cargo);
console.log(`  ✓ src-tauri/Cargo.toml`);

console.log(`\nVersion updated to ${next}`);

// Draft the release commit message from the actual diff (Claude-assisted).
// Kept in a separate script so bumping stays deterministic and offline-capable;
// skip with `--no-notes` when offline or scripting a release.
if (!process.argv.includes('--no-notes')) {
  try {
    execSync(`node ${resolve(root, 'scripts/summarize-release.mjs')} ${next}`, {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    // Never let note drafting fail the bump — the version files are already written.
    console.log('\n⚠ Release-note drafting failed; continuing.');
    console.log(`\nTo release:`);
    console.log(`  git add -A && git commit -m "chore: release v${next}"`);
    console.log(`  git tag v${next}`);
    console.log(`  git push origin main --tags`);
  }
} else {
  console.log(`\nTo release:`);
  console.log(`  git add -A && git commit -m "chore: release v${next}"`);
  console.log(`  git tag v${next}`);
  console.log(`  git push origin main --tags`);
}
