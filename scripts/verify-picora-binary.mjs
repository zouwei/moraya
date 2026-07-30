#!/usr/bin/env node
/**
 * Verify Picora's binary-attachment support against the live API.
 *
 * Checks exactly the contract in docs/specs/picora-binary-attachments.md, and
 * reports each item separately — a partial rollout should read as partial, not
 * as a single pass/fail.
 *
 * Usage:
 *   PICORA_TOKEN=<access token>  node scripts/verify-picora-binary.mjs [kbId]
 *
 * Needs `kb.read` + `kb.write`. Creates a few files under `__moraya_probe__/`
 * in the target KB and deletes them again; nothing else is touched.
 */

const BASE = process.env.PICORA_API ?? 'https://api.picora.me'
const TOKEN = process.env.PICORA_TOKEN
const PREFIX = '__moraya_probe__'

if (!TOKEN) {
  console.error('PICORA_TOKEN is required (an access token with kb.read + kb.write).')
  process.exit(2)
}

/** 1×1 PNG — small, but every byte matters: it has a CRC and a 0x00 byte. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const results = []
function record(id, ok, detail) {
  results.push({ id, ok, detail })
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'
  console.log(`[${mark}] ${id}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Picora-Sync-Version': '2',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  return res
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sync(ops) {
  const res = await api(`/v1/kbs/${encodeURIComponent(kbId)}/sync`, {
    method: 'POST',
    body: JSON.stringify({ ops }),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 300) } }
  // Responses are wrapped as { success, data: { applied, conflicts, … } }.
  const body = parsed?.data ?? parsed
  return { status: res.status, body, envelope: parsed }
}

// ── Resolve a KB to work in ──────────────────────────────────────────────────
let kbId = process.argv[2]
if (!kbId) {
  const res = await api('/v1/kbs?limit=1')
  if (!res.ok) {
    console.error(`Cannot list knowledge bases (HTTP ${res.status}). Check the token's scopes.`)
    process.exit(2)
  }
  const body = await res.json()
  kbId = body?.data?.items?.[0]?.id ?? body?.items?.[0]?.id
  if (!kbId) {
    console.error('No knowledge base found; pass one explicitly: node scripts/verify-picora-binary.mjs <kbId>')
    process.exit(2)
  }
}
console.log(`Knowledge base: ${kbId}\nAPI: ${BASE}\n`)

// ── P0a: does the server accept `encoding: base64` at all? ───────────────────
const pngPath = `${PREFIX}/probe.png`
const pngHash = await sha256(PNG)
const b64 = PNG.toString('base64')
let upsert = await sync([
  { op: 'upsert', relativePath: pngPath, content: b64, sourceHash: pngHash, encoding: 'base64' },
])
let applied = upsert.body?.applied?.find?.((a) => a.relativePath === pngPath)
let note = ''

// A hash mismatch is the tell. `sourceHash` is the hash of the DECODED bytes;
// if the server rejects that but accepts the hash of the base64 *string*, it
// never decoded anything — `encoding` was ignored and the field silently
// stored as text, which is exactly the corruption this contract must prevent.
if (!applied) {
  const reason = upsert.body?.conflicts?.[0]?.reason
  const asText = await sync([
    { op: 'upsert', relativePath: pngPath, content: b64, sourceHash: await sha256(Buffer.from(b64)), encoding: 'base64' },
  ])
  const textApplied = asText.body?.applied?.find?.((a) => a.relativePath === pngPath)
  if (textApplied) {
    note = `server hashed the base64 STRING, not the decoded bytes → encoding ignored (first attempt: ${reason})`
    applied = textApplied
  } else {
    note = `rejected both hashings (${reason} / ${asText.body?.conflicts?.[0]?.reason})`
  }
}
record(
  'P0a accepts encoding:base64',
  upsert.status === 200 && !!upsert.body?.applied?.find?.((a) => a.relativePath === pngPath),
  note || `HTTP ${upsert.status}`,
)

// ── P0b: byte-exact round trip ───────────────────────────────────────────────
if (applied?.docId) {
  const raw = await api(`/v1/docs/${encodeURIComponent(applied.docId)}/raw`)
  if (raw.ok) {
    const back = Buffer.from(await raw.arrayBuffer())
    const backHash = await sha256(back)
    record(
      'P0b byte-exact round trip',
      backHash === pngHash,
      backHash === pngHash
        ? `${back.length} bytes, sha256 matches`
        : `sent ${PNG.length}B/${pngHash.slice(0, 12)} got ${back.length}B/${backHash.slice(0, 12)}`,
    )
  } else {
    record('P0b byte-exact round trip', false, `raw read HTTP ${raw.status}`)
  }
} else {
  record('P0b byte-exact round trip', null, 'upsert did not apply')
}

// ── P0c: `encoding` must be optional (old clients keep working) ──────────────
const utf8Path = `${PREFIX}/plain.typ`
const utf8 = Buffer.from('= Probe\n')
const legacy = await sync([
  { op: 'upsert', relativePath: utf8Path, content: utf8.toString('utf8'), sourceHash: await sha256(utf8) },
])
record(
  'P0c omitting encoding still works',
  legacy.status === 200 && !!legacy.body?.applied?.find?.((a) => a.relativePath === utf8Path),
  `HTTP ${legacy.status}`,
)

// ── P1a: non-document extensions ─────────────────────────────────────────────
const extResults = []
for (const [name, text] of [['refs.bib', '@article{a}'], ['data.csv', 'a,b'], ['conf.toml', 'k = 1']]) {
  const p = `${PREFIX}/${name}`
  const buf = Buffer.from(text)
  const r = await sync([{ op: 'upsert', relativePath: p, content: text, sourceHash: await sha256(buf) }])
  extResults.push(`${name}:${r.status === 200 && r.body?.applied?.length ? 'ok' : `HTTP ${r.status}`}`)
}
record('P1a auxiliary extensions accepted', extResults.every((r) => r.endsWith(':ok')), extResults.join(' '))

// ── P1b: is a multi-op batch atomic? ─────────────────────────────────────────
// Pair a valid op with one that must fail (a stale base). If the batch is
// atomic the good one must NOT have landed.
const atomicGood = `${PREFIX}/atomic-good.typ`
const atomicBad = `${PREFIX}/atomic-bad.typ`
const goodBuf = Buffer.from('= Good\n')
const badBuf = Buffer.from('= Bad\n')
const batch = await sync([
  { op: 'upsert', relativePath: atomicGood, content: goodBuf.toString(), sourceHash: await sha256(goodBuf) },
  {
    op: 'upsert',
    relativePath: atomicBad,
    content: badBuf.toString(),
    sourceHash: await sha256(badBuf),
    baseUpdatedAt: '1999-01-01T00:00:00.000Z', // stale base → must conflict
  },
])
const goodLanded = !!batch.body?.applied?.find?.((a) => a.relativePath === atomicGood)
const badRejected =
  !!batch.body?.conflicts?.find?.((c) => c.relativePath === atomicBad) ||
  !batch.body?.applied?.find?.((a) => a.relativePath === atomicBad)
record(
  'P1b batch atomicity',
  null,
  badRejected
    ? goodLanded
      ? 'NOT atomic — the valid op applied while its neighbour was rejected (client-side rollback stays necessary)'
      : 'atomic — one rejected op rolled the whole batch back'
    : 'inconclusive: the "bad" op was not rejected',
)

// ── P2: CORS exposes the sync metadata headers ───────────────────────────────
if (applied?.docId) {
  const res = await api(`/v1/docs/${encodeURIComponent(applied.docId)}/raw`)
  const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase()
  const hasHeaders = !!res.headers.get('x-source-hash') && !!res.headers.get('x-updated-at')
  record(
    'P2 X-Source-Hash / X-Updated-At exposed to browsers',
    hasHeaders && exposed.includes('x-source-hash') && exposed.includes('x-updated-at'),
    `present=${hasHeaders} expose="${exposed || '(none)'}"`,
  )
}

// ── Clean up ─────────────────────────────────────────────────────────────────
const cleanup = [pngPath, utf8Path, atomicGood, atomicBad, `${PREFIX}/refs.bib`, `${PREFIX}/data.csv`, `${PREFIX}/conf.toml`]
await sync(cleanup.map((relativePath) => ({ op: 'delete', relativePath })))
console.log(`\nProbe files under ${PREFIX}/ removed.`)

const failed = results.filter((r) => r.ok === false)
console.log(`\n${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, ${results.filter((r) => r.ok === null).length} informational.`)
process.exit(failed.length > 0 ? 1 : 0)
