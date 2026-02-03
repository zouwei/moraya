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
 */

import { readFileSync, writeFileSync } from 'fs';
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
console.log(`\nTo release:`);
console.log(`  git add -A && git commit -m "chore: release v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push origin main --tags`);
