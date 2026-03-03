#!/usr/bin/env node

/**
 * Sync renderer plugin versions from npm registry.
 *
 * Reads the plugin list from renderer-registry.ts, fetches the latest stable
 * version of each npm package, and writes the result to renderer-versions.json.
 *
 * Called automatically by bump-version.mjs during `pnpm version:bump`.
 * Can also be run manually: node scripts/sync-renderer-plugins.mjs
 *
 * Files updated:
 *   - src/lib/services/plugin/renderer-versions.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const versionsPath = resolve(root, 'src/lib/services/plugin/renderer-versions.json');
const registryPath = resolve(root, 'src/lib/services/plugin/renderer-registry.ts');

/**
 * Extract npm package names from renderer-registry.ts.
 * Looks for lines like: npmPackage: 'abcjs'
 */
function extractPackagesFromRegistry() {
  if (!existsSync(registryPath)) {
    console.log('  renderer-registry.ts not found, nothing to sync.');
    return [];
  }
  const source = readFileSync(registryPath, 'utf-8');
  const matches = [...source.matchAll(/npmPackage\s*:\s*['"]([^'"]+)['"]/g)];
  return [...new Set(matches.map(m => m[1]))];
}

/**
 * Fetch latest stable version of an npm package.
 * Returns null on failure (network error, package not found, etc.).
 */
async function fetchLatestVersion(pkg) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`  ⚠ ${pkg}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.version ?? null;
  } catch (err) {
    console.warn(`  ⚠ ${pkg}: ${err.message}`);
    return null;
  }
}

// --- Main ---

const packages = extractPackagesFromRegistry();

if (packages.length === 0) {
  console.log('  No renderer plugins registered, skipping version sync.');
  process.exit(0);
}

// Load existing versions (preserve manually pinned entries)
let existing = {};
if (existsSync(versionsPath)) {
  try {
    existing = JSON.parse(readFileSync(versionsPath, 'utf-8'));
  } catch {
    existing = {};
  }
}

const updated = { ...existing };
let changed = 0;

for (const pkg of packages) {
  const latest = await fetchLatestVersion(pkg);
  if (!latest) continue;

  const prev = updated[pkg];
  if (prev !== latest) {
    console.log(`  ${pkg}: ${prev ?? '(new)'} → ${latest}`);
    updated[pkg] = latest;
    changed++;
  }
}

if (changed === 0) {
  console.log('  All renderer plugin versions are up to date.');
} else {
  writeFileSync(versionsPath, JSON.stringify(updated, null, 2) + '\n');
  console.log(`  Updated ${changed} package version(s) in renderer-versions.json`);
}
