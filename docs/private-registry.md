# Private npm registry (GitHub Packages) — installation guide

`@moraya/markdown-core` is a **private** npm package hosted on GitHub Packages. Installing it requires a GitHub Personal Access Token (PAT) with the `read:packages` scope. This document covers the auth flow for local development, GitHub Actions CI, and Docker builds.

Source: spec [§5 of `v0.60.0-pre-shared-markdown-core.md`](iterations/v0.60.0-pre-shared-markdown-core.md#5-私有-npm-registry-配置github-packages).

---

## TL;DR

```bash
# 1. Create a fine-grained PAT (one-time)
#    https://github.com/settings/tokens?type=beta
#    Repository: zouwei/moraya-markdown-core
#    Permissions: Contents Read, Metadata Read, Packages Read

# 2. Add to ~/.npmrc (NOT this repo's .npmrc — keep tokens out of git)
cat >> ~/.npmrc <<'EOF'
@moraya:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_YOUR_PAT_HERE
EOF

# 3. Install
pnpm install
```

A template is provided at [.npmrc.example](../.npmrc.example).

---

## Why GitHub Packages

| Option | Auth | Cost | Pick? |
|---|---|---|---|
| **GitHub Packages** | PAT with `read:packages` | Free with private repo (500 MB included) | ✅ |
| Verdaccio (self-hosted) | Custom user/pass | VPS + maintenance | ❌ extra ops |
| npm Pro | npm token | $7/user/month | ❌ extra spend |

GitHub Packages integrates with the existing private GitHub repo and PATs developers already hold, with no separate billing or new service to maintain.

---

## Local development

### One-time PAT setup

1. Go to https://github.com/settings/tokens?type=beta (Fine-grained tokens)
2. Token name: `moraya-markdown-core read` (or similar)
3. Expiration: 90 days (renew as needed)
4. Repository access: **Only select repositories** → `zouwei/moraya-markdown-core`
5. Permissions:
   - Repository → **Contents: Read-only**
   - Repository → **Metadata: Read-only**
   - Repository → **Packages: Read-only**
6. Generate token; copy the `ghp_...` string

### Configure `~/.npmrc`

Edit `~/.npmrc` (create it if it doesn't exist):

```
@moraya:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_YOUR_PAT_HERE
```

> ⚠️ Use `~/.npmrc` (your home directory), not the repo's `.npmrc`. The repo's `.npmrc` is gitignored to prevent accidental commits, but the safer pattern is to never write a real token into a tracked path.

### Verify

```bash
pnpm install   # should resolve @moraya/markdown-core without 401
pnpm tauri dev
```

If you see `npm error code E401` or `npm error 401 Unauthorized`, the PAT is missing or lacks `read:packages`.

---

## GitHub Actions CI

The `GITHUB_TOKEN` automatically provided to every workflow run already has `read:packages` scope when the workflow's repository is in the same organization as the package. No PAT needed.

In `.github/workflows/ci.yml`:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: pnpm
    registry-url: 'https://npm.pkg.github.com'
    scope: '@moraya'

- name: Install
  run: pnpm install --frozen-lockfile
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Cross-org consumption** (e.g. moraya-web is in a different org from moraya-markdown-core): the workflow needs a fine-grained PAT stored as a repo secret (e.g. `GH_PACKAGES_READ_TOKEN`), used in place of `secrets.GITHUB_TOKEN`.

---

## Docker builds

Multi-stage builds keep the token in the builder layer and out of the runtime image.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
ARG GITHUB_TOKEN
WORKDIR /app

# Write .npmrc only inside the builder layer
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    pnpm install --frozen-lockfile

# OR (less secure — token visible in build args):
# RUN echo "@moraya:registry=https://npm.pkg.github.com" > .npmrc \
#  && echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc \
#  && pnpm install --frozen-lockfile \
#  && rm -f .npmrc

COPY . .
RUN pnpm build

# Runtime image — no .npmrc, no token
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/
CMD ["node", "dist/server.js"]
```

Build with:

```bash
# Preferred (BuildKit secret mount, never embedded in any layer):
DOCKER_BUILDKIT=1 docker build \
  --secret id=npmrc,src=$HOME/.npmrc \
  -t moraya-app .

# Fallback (token embedded in build args — visible in build cache):
docker build --build-arg GITHUB_TOKEN=$GITHUB_TOKEN -t moraya-app .
```

---

## Cloudflare Workers / Pages

`wrangler deploy` operates on the already-built `dist/`; it does not run `pnpm install`. The CI step that produced `dist/` is the only place a token is needed. The Workers runtime never sees `.npmrc`.

---

## Pre-publication bridge

Until `@moraya/markdown-core@0.1.0` is officially published to GitHub Packages, this repo consumes a **vendored tarball** under `./vendor/moraya-markdown-core-0.1.0.tgz`:

```jsonc
// package.json
{
  "dependencies": {
    "@moraya/markdown-core": "file:vendor/moraya-markdown-core-0.1.0.tgz"
  }
}
```

This is acceptable per spec §1.3.4 ("Local iteration without a publish round-trip"). The boundary CI gate at [.github/workflows/ci.yml](../.github/workflows/ci.yml) explicitly allows `file:vendor/*.tgz` while still blocking sibling-path `file:../`, `link:`, and `workspace:` protocols.

Once `0.1.0` is published, switch to:

```jsonc
{
  "dependencies": {
    "@moraya/markdown-core": "^0.1.0"
  }
}
```

and run `pnpm install` to fetch from the registry.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `npm error 401 Unauthorized` | PAT missing or lacks `read:packages` | Re-run PAT setup; check token scope |
| `npm error 403 Forbidden` | PAT cannot access this specific repo | Make the PAT fine-grained and add `zouwei/moraya-markdown-core` to "Selected repositories" |
| `npm error 404 Not Found` for `@moraya/markdown-core` | Registry URL incorrect or token has no read access | Verify `@moraya:registry=https://npm.pkg.github.com` in `~/.npmrc` |
| `ERR_PNPM_OUTDATED_LOCKFILE` after `package.json` swap to `^0.1.0` | Lockfile still references the tarball | Delete `pnpm-lock.yaml` entry for `@moraya/markdown-core` and re-run `pnpm install` |
| Boundary CI gate ("Forbid sibling-path imports") fails | Some PR introduced `from '../moraya-markdown-core/...'` or a `link:` / `workspace:` declaration | Replace with the published package import; see spec §1.3 |

---

## Boundary reminder (spec §1.3 — hard rule)

`@moraya/markdown-core` is consumed via the published package only. Any of the following blocks PR merge via [.github/workflows/ci.yml](../.github/workflows/ci.yml) "Forbid sibling-path imports of @moraya/markdown-core":

- ❌ `import { ... } from '../moraya-markdown-core/...'`
- ❌ `import { ... } from './moraya-markdown-core/...'`
- ❌ `tsconfig.json` `paths` mapping into the sibling repo
- ❌ `package.json` dep declared as `file:../`, `link:`, or `workspace:`
- ❌ `pnpm-workspace.yaml` referencing the sibling

The `./moraya-markdown-core/` symlink at the repo root is for cross-repo editing convenience only and is gitignored. Removing it must not affect `pnpm install && pnpm tauri build`.
