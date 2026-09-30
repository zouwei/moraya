#!/usr/bin/env node

/**
 * Guard the `@moraya/core` dependency form + publication status.
 *
 * ONE script, TWO call sites (merged per the release-safety design):
 *   • 方案 A — release gate: run in `release.yml` (PC) / `deploy.sh` (web)
 *     in `release` mode before any build/upload.
 *   • 方案 B — pre-push hook: `.githooks/pre-push` runs this in `release`
 *     mode when a `v*` tag is being pushed, `dev` mode otherwise.
 *
 * The problem it solves: `@moraya/core` can be consumed locally via a frozen
 * vendored tarball (`file:./vendor/*.tgz`) as a pre-publication bridge (per
 * AGENTS.md §1.3). That tarball passes ordinary CI and can be BUILT into a
 * shipped app — but the corresponding core version may never have been
 * published to npm. This guard makes a release FAIL CLOSED until core is
 * published and the dependency is switched back to a registry range.
 *
 * Modes:
 *   dev      (default) — protocol check only, no network. Allows an npm
 *                        semver range (^X.Y.Z) OR a frozen vendored tarball
 *                        (file:./vendor/*.tgz | file:vendor/*.tgz). Rejects
 *                        sibling paths (file:../…), link:, workspace:, git:.
 *
 *   release  — STRICT. The dependency MUST be an npm semver range (no
 *              vendored tarball, no file:/link:/workspace:), AND that range
 *              must resolve to a version already published on npm. Network
 *              required; fails closed if the registry is unreachable — a
 *              release must be verifiable.
 *
 * Usage:
 *   node scripts/check-core-dep.mjs            # dev mode
 *   node scripts/check-core-dep.mjs release    # release mode
 *
 * Exit 0 = OK · exit 1 = violation.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = '@moraya/core';
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = resolve(__dirname, '..', 'package.json');

function fail(msg) {
  // `::error::` is a GitHub Actions annotation; harmless in a local shell.
  console.error(`::error::[check-core-dep] ${msg}`);
  process.exit(1);
}

const mode = (process.argv[2] || 'dev').replace(/^--/, '');
if (mode !== 'dev' && mode !== 'release') {
  fail(`unknown mode "${mode}" — expected "dev" or "release"`);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
const spec =
  pkg.dependencies?.[PKG] ??
  pkg.devDependencies?.[PKG] ??
  pkg.optionalDependencies?.[PKG];

if (!spec) {
  // Not every consumer depends on core (e.g. moraya-mobile bundles the web
  // build and has no direct dep). Nothing to guard.
  console.log(`[check-core-dep] ${PKG} not in dependencies — nothing to guard.`);
  process.exit(0);
}

console.log(`[check-core-dep] mode=${mode}  ${PKG} = "${spec}"`);

const isVendoredTarball = /^file:(\.\/)?vendor\/[^/]+\.tgz$/.test(spec);
const isNonRegistry = /^(file:|link:|workspace:|git\+|git:|https?:)/.test(spec);

if (mode === 'dev') {
  if (isVendoredTarball) {
    console.log('[check-core-dep] OK — frozen vendored tarball bridge (dev-only).');
    process.exit(0);
  }
  if (isNonRegistry) {
    fail(
      `${PKG} points at a local/sibling source ("${spec}").\n` +
        `  Allowed in dev: an npm range (e.g. ^X.Y.Z) or a frozen ./vendor/*.tgz tarball.\n` +
        `  Never allowed: file:../sibling, link:, workspace:, git URLs.`,
    );
  }
  console.log('[check-core-dep] OK — npm registry range.');
  process.exit(0);
}

// ── mode === 'release' — strict ──────────────────────────────────────────────

if (isVendoredTarball) {
  fail(
    `${PKG} is still on the vendored tarball bridge ("${spec}").\n` +
      `  A release must consume the PUBLISHED npm package. Runbook:\n` +
      `    1. In moraya-core:  pnpm version:bump <patch|minor|major>\n` +
      `                        git commit + tag + push  → publishes to npm\n` +
      `    2. Wait until  npm view ${PKG}@<new> version  succeeds\n` +
      `    3. Here:  set "${PKG}": "^<new>" in package.json\n` +
      `    4. pnpm install  &&  commit package.json + lockfile\n` +
      `  Then re-run the release. (Override in a genuine emergency: git push --no-verify)`,
  );
}
if (isNonRegistry) {
  fail(
    `${PKG} points at a non-registry source ("${spec}"). ` +
      `A release must use a published npm range like "^X.Y.Z".`,
  );
}

// It's an npm range — verify it resolves to a PUBLISHED version.
let resolved = '';
try {
  resolved = execSync(`npm view "${PKG}@${spec}" version`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
} catch (e) {
  const firstLine = String(e.stderr || e.message || '').split('\n')[0];
  fail(
    `could not verify "${PKG}@${spec}" on npm.\n` +
      `  The version may be unpublished, or the registry is unreachable.\n` +
      `  A release fails closed here — publish moraya-core first (or check your network).\n` +
      `  npm said: ${firstLine}`,
  );
}
if (!resolved) {
  fail(`no published version of ${PKG} satisfies "${spec}". Publish moraya-core first.`);
}

// `npm view pkg@range version` may print multiple `pkg@x 'x'` lines when a
// range matches several published versions — any non-empty result means the
// range resolves to something real, which is all we require.
const shown = resolved.split('\n').pop().trim();
console.log(`[check-core-dep] OK — "${spec}" resolves to published ${PKG}@${shown}.`);
process.exit(0);
