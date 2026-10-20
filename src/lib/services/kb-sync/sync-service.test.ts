import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// ── Module mocks (must be hoisted before imports) ─────────────────────

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./manifest', () => ({
  buildLocalManifest: vi.fn(),
  loadLastManifest: vi.fn(),
  saveLastManifest: vi.fn(),
  moveToTrash: vi.fn(),
}));

vi.mock('./picora-kb-client', () => ({
  picoraApiBase: vi.fn((url: string) => url.replace('/upload', '')),
  listKbs: vi.fn(),
  createKb: vi.fn(),
  fetchManifest: vi.fn(),
  syncBatch: vi.fn(),
  fetchRaw: vi.fn(),
}));

// Cloud-sync entitlement gate — default to an entitled ('pro') account so the
// existing behavior tests exercise real sync; individual tests override
// getPicoraPlan to 'none' to assert the gate blocks.
vi.mock('$lib/services/picora/entitlement', () => ({
  getPicoraPlan: vi.fn().mockResolvedValue('pro'),
  isKbSyncEntitled: vi.fn((plan: string | null | undefined) => !!plan && plan !== 'none'),
}));

// Local version history backs the "remote is our own prior version" fast-
// forward; default to no history, individual tests override.
vi.mock('$lib/services/version-history', () => ({
  listVersions: vi.fn().mockResolvedValue([]),
}));

// The gate resolves its user-facing reason via the i18n store; stub it so the
// dynamic import doesn't drag the locale JSON loader into the test env.
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store');
  return { t: readable((k: string) => k) };
});

import { invoke } from '@tauri-apps/api/core';
import { buildLocalManifest, loadLastManifest, saveLastManifest, moveToTrash } from './manifest';
import { fetchManifest, syncBatch, fetchRaw } from './picora-kb-client';
import { getPicoraPlan } from '$lib/services/picora/entitlement';
import { listVersions } from '$lib/services/version-history';
import { kbSyncStore, runSync, dryRunSync, clearAllIntervals, isMemoryNamespacePath } from './sync-service';
import type { KbBinding, LocalManifestEntry, ManifestEntry, ConflictEntry, SyncBatchResult, RemoteManifest } from './types';
import type { VersionEntry } from '$lib/services/version-history';
import type { KnowledgeBase } from '$lib/stores/files-store';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';

// ── Test fixtures ─────────────────────────────────────────────────────

function makeBinding(overrides?: Partial<KbBinding>): KbBinding {
  return {
    localKbId: 'kb-1',
    picoraTargetId: 'target-1',
    picoraKbId: 'remote-kb-1',
    picoraKbName: 'Test KB',
    strategy: {
      mode: 'manual',
      intervalSecs: 300,
      scope: 'markdown-plus-rules',
      excludePatterns: [],
      conflictPolicy: 'prompt',
      maxFileSizeBytes: 2 * 1024 * 1024,
    },
    lastSyncAt: null,
    lastSyncReport: null,
    lastSyncError: null,
    ...overrides,
  };
}

function makeKb(): KnowledgeBase {
  return {
    id: 'kb-1',
    name: 'Test KB',
    path: '/Users/test/TestKB',
  } as KnowledgeBase;
}

function makeTarget(): ImageHostTarget {
  return {
    id: 'target-1',
    provider: 'picora',
    picoraApiUrl: 'https://picora.example.com/upload',
    picoraApiKey: 'sk-test-key',
  } as unknown as ImageHostTarget;
}

function localEntry(hash: string, size = 100): LocalManifestEntry {
  return { relativePath: '', sourceHash: hash, sizeBytes: size, mtime: Date.now() };
}

function remoteEntry(hash: string, size = 100): ManifestEntry {
  return {
    relativePath: '',
    sourceHash: hash,
    sizeBytes: size,
    updatedAt: new Date().toISOString(),
  };
}

const SERVER_TS = '2026-10-20T01:02:03.000Z';

/** Server batch response with each path applied as an upsert. */
function applied(paths: string[], sourceHash: string | null = null): SyncBatchResult {
  return {
    applied: paths.map(relativePath => ({
      op: 'upsert' as const, relativePath, id: 'doc-id-0000000000000', updatedAt: SERVER_TS, sourceHash,
    })),
    conflicts: [],
    skipped: [],
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearAllIntervals();
});

describe('kbSyncStore', () => {
  it('initialises as empty Map', () => {
    const state = get(kbSyncStore);
    expect(state instanceof Map).toBe(true);
  });

  it('setState updates a single kb entry', () => {
    kbSyncStore.setState('kb-x', { status: 'syncing', conflictCount: 0, pendingConflicts: [], lastError: null });
    const s = kbSyncStore.getState('kb-x');
    expect(s.status).toBe('syncing');
  });

  it('getState returns default for unknown kb', () => {
    const s = kbSyncStore.getState('kb-unknown');
    expect(s.status).toBe('unbound');
    expect(s.conflictCount).toBe(0);
  });
});

describe('dryRunSync', () => {
  it('returns diff summary without executing ops', async () => {
    const local = new Map([['note.md', localEntry('aaa')]]);
    const last = new Map<string, ManifestEntry>();
    const remoteEntries: ManifestEntry[] = [];

    vi.mocked(buildLocalManifest).mockResolvedValue(local);
    vi.mocked(loadLastManifest).mockResolvedValue(last);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);

    const result = await dryRunSync(makeBinding(), makeKb(), makeTarget());

    expect(result.uploaded).toBe(1);
    expect(result.downloaded).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.diff).toBeDefined();
    expect(result.diff?.uploadPaths).toContain('note.md');

    // No real ops should fire
    expect(syncBatch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sets kbSyncStore status to idle after dry-run', async () => {
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map());
    vi.mocked(loadLastManifest).mockResolvedValue(new Map());
    vi.mocked(fetchManifest).mockResolvedValue([]);

    await dryRunSync(makeBinding(), makeKb(), makeTarget());

    expect(kbSyncStore.getState('kb-1').status).toBe('idle');
  });
});

describe('runSync — success path', () => {
  it('uploads a new local file and saves manifest', async () => {
    const localManifest = new Map([['note.md', localEntry('aaa')]]);
    const lastManifest = new Map<string, ManifestEntry>();
    const remoteEntries: ManifestEntry[] = [];

    vi.mocked(buildLocalManifest).mockResolvedValue(localManifest);
    vi.mocked(loadLastManifest).mockResolvedValue(lastManifest);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);
    vi.mocked(invoke).mockResolvedValue('# Hello');
    vi.mocked(syncBatch).mockResolvedValue(applied(['note.md']));

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.uploaded).toBe(1);
    expect(saveLastManifest).toHaveBeenCalledOnce();
    expect(kbSyncStore.getState('kb-1').status).toBe('idle');
  });

  it('downloads a new remote file and writes it locally', async () => {
    const localManifest = new Map<string, LocalManifestEntry>();
    const lastManifest = new Map<string, ManifestEntry>();
    const remoteEntries: ManifestEntry[] = [{
      relativePath: 'remote.md',
      sourceHash: 'bbb',
      sizeBytes: 50,
      updatedAt: new Date().toISOString(),
    }];

    vi.mocked(buildLocalManifest).mockResolvedValue(localManifest);
    vi.mocked(loadLastManifest).mockResolvedValue(lastManifest);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);
    vi.mocked(fetchRaw).mockResolvedValue('# Remote');
    vi.mocked(invoke).mockResolvedValue(undefined); // write_file

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.downloaded).toBe(1);
    expect(fetchRaw).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'remote-kb-1',
      'remote.md',
    );
    expect(invoke).toHaveBeenCalledWith('write_file', expect.objectContaining({
      path: expect.stringContaining('remote.md'),
    }));
  });

  it('deletes local file (move to trash) when remote deleted it', async () => {
    const lastManifest = new Map<string, ManifestEntry>([
      ['gone.md', { relativePath: 'gone.md', sourceHash: 'aaa', sizeBytes: 50, updatedAt: '' }],
    ]);
    const localManifest = new Map([['gone.md', localEntry('aaa')]]);
    const remoteEntries: ManifestEntry[] = [];

    vi.mocked(buildLocalManifest).mockResolvedValue(localManifest);
    vi.mocked(loadLastManifest).mockResolvedValue(lastManifest);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.deletedLocal).toBe(1);
    expect(moveToTrash).toHaveBeenCalledWith('/Users/test/TestKB', 'kb-1', 'gone.md');
  });

  it('detects conflict and sets kbSyncStore to conflict', async () => {
    const lastManifest = new Map<string, ManifestEntry>([
      ['conflict.md', { relativePath: 'conflict.md', sourceHash: 'aaa', sizeBytes: 50, updatedAt: '' }],
    ]);
    const localManifest = new Map([['conflict.md', localEntry('bbb')]]);
    const remoteEntries: ManifestEntry[] = [{
      relativePath: 'conflict.md',
      sourceHash: 'ccc',
      sizeBytes: 50,
      updatedAt: new Date().toISOString(),
    }];

    vi.mocked(buildLocalManifest).mockResolvedValue(localManifest);
    vi.mocked(loadLastManifest).mockResolvedValue(lastManifest);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);
    vi.mocked(syncBatch).mockResolvedValue(applied([]));

    vi.mocked(invoke).mockResolvedValue('# local'); // read_file
    vi.mocked(fetchRaw).mockResolvedValue('# remote');

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect((report.conflicts as ConflictEntry[]).length).toBeGreaterThan(0);
    const state = kbSyncStore.getState('kb-1');
    expect(state.status).toBe('conflict');
    expect(state.conflictCount).toBeGreaterThan(0);
    // Conflict entries carry full content for the line-level resolution UI.
    expect(state.pendingConflicts[0].localContent).toBe('# local');
    expect(state.pendingConflicts[0].remoteContent).toBe('# remote');
  });

  it('conflictPolicy prefer-local auto-uploads the local version (no prompt)', async () => {
    const last = new Map<string, ManifestEntry>([
      ['c.md', { relativePath: 'c.md', sourceHash: 'aaa', sizeBytes: 50, updatedAt: '' }],
    ]);
    const local = new Map([['c.md', localEntry('bbb')]]);
    const remoteEntries: ManifestEntry[] = [{
      relativePath: 'c.md', sourceHash: 'ccc', sizeBytes: 50, updatedAt: new Date().toISOString(),
    }];

    vi.mocked(buildLocalManifest).mockResolvedValue(local);
    vi.mocked(loadLastManifest).mockResolvedValue(last);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);
    vi.mocked(invoke).mockResolvedValue('# local content'); // read_file
    vi.mocked(fetchRaw).mockResolvedValue('# remote content');
    vi.mocked(syncBatch).mockResolvedValue(applied(['c.md']));

    const binding = makeBinding({
      strategy: { ...makeBinding().strategy, conflictPolicy: 'prefer-local' },
    });
    const report = await runSync(binding, makeKb(), makeTarget(), false);

    expect(report.uploaded).toBeGreaterThan(0);
    expect((report.conflicts as ConflictEntry[]).length).toBe(0);
    expect(kbSyncStore.getState('kb-1').status).toBe('idle');
    expect(syncBatch).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'remote-kb-1',
      expect.arrayContaining([
        expect.objectContaining({ op: 'upsert', relativePath: 'c.md', content: '# local content' }),
      ]),
    );
  });

  it('conflictPolicy prefer-remote downloads the remote version', async () => {
    const last = new Map<string, ManifestEntry>([
      ['c.md', { relativePath: 'c.md', sourceHash: 'aaa', sizeBytes: 50, updatedAt: '' }],
    ]);
    const local = new Map([['c.md', localEntry('bbb')]]);
    const remoteEntries: ManifestEntry[] = [{
      relativePath: 'c.md', sourceHash: 'ccc', sizeBytes: 50, updatedAt: new Date().toISOString(),
    }];

    vi.mocked(buildLocalManifest).mockResolvedValue(local);
    vi.mocked(loadLastManifest).mockResolvedValue(last);
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);
    vi.mocked(invoke).mockResolvedValue(undefined); // read_file / write_file
    vi.mocked(fetchRaw).mockResolvedValue('# remote content');

    const binding = makeBinding({
      strategy: { ...makeBinding().strategy, conflictPolicy: 'prefer-remote' },
    });
    const report = await runSync(binding, makeKb(), makeTarget(), false);

    expect(report.downloaded).toBeGreaterThan(0);
    expect((report.conflicts as ConflictEntry[]).length).toBe(0);
    expect(kbSyncStore.getState('kb-1').status).toBe('idle');
    expect(invoke).toHaveBeenCalledWith('write_file', expect.objectContaining({
      content: '# remote content',
    }));
  });

  it('calls onComplete callback with the sync report', async () => {
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map());
    vi.mocked(loadLastManifest).mockResolvedValue(new Map());
    vi.mocked(fetchManifest).mockResolvedValue([]);

    const onComplete = vi.fn();
    await runSync(makeBinding(), makeKb(), makeTarget(), false, onComplete);

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ uploaded: 0 }));
  });
});

describe('runSync — incremental updates (no false conflicts)', () => {
  const T1 = '2026-10-19T10:00:00.000Z';

  it('records the server updatedAt/sourceHash (not client time) after an upload', async () => {
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map([['note.md', localEntry('aaa')]]));
    vi.mocked(loadLastManifest).mockResolvedValue(new Map());
    vi.mocked(fetchManifest).mockResolvedValue([]);
    vi.mocked(invoke).mockResolvedValue('# Hello');
    vi.mocked(syncBatch).mockResolvedValue(applied(['note.md'], 'f'.repeat(64)));

    await runSync(makeBinding(), makeKb(), makeTarget(), false);

    const saved = vi.mocked(saveLastManifest).mock.calls[0][1] as RemoteManifest;
    expect(saved.get('note.md')).toMatchObject({ updatedAt: SERVER_TS, sourceHash: 'f'.repeat(64) });
  });

  it('a local edit after a completed sync uploads with the observed remote version as base', async () => {
    // Last sync agreed on v1 (T1); the remote still holds v1; local edited to v2.
    vi.mocked(loadLastManifest).mockResolvedValue(new Map([
      ['note.md', { relativePath: 'note.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 }],
    ]));
    vi.mocked(fetchManifest).mockResolvedValue([
      { relativePath: 'note.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 },
    ]);
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map([['note.md', localEntry('h2')]]));
    vi.mocked(invoke).mockResolvedValue('# v2');
    vi.mocked(syncBatch).mockResolvedValue(applied(['note.md']));

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.uploaded).toBe(1);
    expect(report.conflicts).toHaveLength(0);
    expect(kbSyncStore.getState('kb-1').status).toBe('idle');
    expect(syncBatch).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'remote-kb-1', [
      expect.objectContaining({ op: 'upsert', relativePath: 'note.md', baseUpdatedAt: T1, sourceHash: await sha256('# v2') }),
    ]);
  });

  it('sends the hash of the content actually uploaded, not the scan-time hash', async () => {
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map([['note.md', localEntry('stale-scan-hash')]]));
    vi.mocked(loadLastManifest).mockResolvedValue(new Map());
    vi.mocked(fetchManifest).mockResolvedValue([]);
    vi.mocked(invoke).mockResolvedValue('# saved again');
    vi.mocked(syncBatch).mockResolvedValue(applied(['note.md']));

    await runSync(makeBinding(), makeKb(), makeTarget(), false);

    const op = vi.mocked(syncBatch).mock.calls[0][3][0];
    expect(op.sourceHash).toBe(await sha256('# saved again'));
    expect(op).not.toHaveProperty('baseUpdatedAt'); // brand-new file: create semantics
  });

  it('remote deletes carry the observed remote version as base', async () => {
    vi.mocked(loadLastManifest).mockResolvedValue(new Map([
      ['old.md', { relativePath: 'old.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 }],
    ]));
    vi.mocked(fetchManifest).mockResolvedValue([
      { relativePath: 'old.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 },
    ]);
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map());
    vi.mocked(syncBatch).mockResolvedValue({
      applied: [{ op: 'delete', relativePath: 'old.md', id: null, updatedAt: null, sourceHash: null }],
      conflicts: [],
      skipped: [],
    });

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.deletedRemote).toBe(1);
    expect(syncBatch).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'remote-kb-1', [
      { op: 'delete', relativePath: 'old.md', baseUpdatedAt: T1 },
    ]);
  });

  it('self-heals a stale last-synced manifest when the remote is a version this device had', async () => {
    // Older builds never recorded uploads: last still says h0 although this
    // device already uploaded h1, then edited on to h2.
    vi.mocked(loadLastManifest).mockResolvedValue(new Map([
      ['note.md', { relativePath: 'note.md', sourceHash: 'h0', sizeBytes: 10, updatedAt: '2026-10-01T00:00:00.000Z' }],
    ]));
    vi.mocked(fetchManifest).mockResolvedValue([
      { relativePath: 'note.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 },
    ]);
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map([['note.md', localEntry('h2')]]));
    vi.mocked(listVersions).mockResolvedValueOnce([{ sourceHash: 'h2' }, { sourceHash: 'h1' }] as VersionEntry[]);
    vi.mocked(invoke).mockResolvedValue('# v2');
    vi.mocked(fetchRaw).mockResolvedValue('# v1');
    vi.mocked(syncBatch).mockResolvedValue(applied(['note.md']));

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.conflicts).toHaveLength(0);
    expect(report.uploaded).toBe(1);
    expect(syncBatch).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'remote-kb-1', [
      expect.objectContaining({ op: 'upsert', relativePath: 'note.md', content: '# v2', baseUpdatedAt: T1 }),
    ]);
    const saved = vi.mocked(saveLastManifest).mock.calls[0][1] as RemoteManifest;
    expect(saved.get('note.md')?.updatedAt).toBe(SERVER_TS);
  });

  it('surfaces an upload the server refused (remote moved on) as a conflict', async () => {
    vi.mocked(loadLastManifest).mockResolvedValue(new Map([
      ['note.md', { relativePath: 'note.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 }],
    ]));
    vi.mocked(fetchManifest).mockResolvedValue([
      { relativePath: 'note.md', sourceHash: 'h1', sizeBytes: 10, updatedAt: T1 },
    ]);
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map([['note.md', localEntry('h2')]]));
    vi.mocked(invoke).mockResolvedValue('# local v2');
    vi.mocked(fetchRaw).mockResolvedValue('# written elsewhere');
    vi.mocked(syncBatch).mockResolvedValue({
      applied: [],
      conflicts: [{
        op: 'upsert', relativePath: 'note.md', reason: 'REMOTE_NEWER',
        remote: { sourceHash: 'h3', sizeBytes: 19, updatedAt: '2026-10-19T11:00:00.000Z', deletedAt: null },
      }],
      skipped: [],
    });

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.uploaded).toBe(0);
    expect(report.conflicts).toHaveLength(1);
    const state = kbSyncStore.getState('kb-1');
    expect(state.status).toBe('conflict');
    expect(state.pendingConflicts[0]).toMatchObject({
      relativePath: 'note.md', remoteHash: 'h3', remoteUpdatedAt: '2026-10-19T11:00:00.000Z',
      localContent: '# local v2', remoteContent: '# written elsewhere',
    });
    // Baseline is not advanced for a refused upload.
    const saved = vi.mocked(saveLastManifest).mock.calls[0][1] as RemoteManifest;
    expect(saved.get('note.md')?.sourceHash).toBe('h1');
  });
});

describe('runSync — cloud-sync entitlement gate', () => {
  it('blocks sync with no active plan: no network, error state carries the reason', async () => {
    vi.mocked(getPicoraPlan).mockResolvedValueOnce('none');

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    // Early return with a zeroed report — and crucially, no KB-sync request.
    expect(report.uploaded).toBe(0);
    expect(report.conflicts).toHaveLength(0);
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(syncBatch).not.toHaveBeenCalled();
    expect(buildLocalManifest).not.toHaveBeenCalled();
    const state = kbSyncStore.getState('kb-1');
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('kb_sync.gate.no_plan');
  });

  it('dry-run with no plan returns zeros in idle state, no manifest fetch', async () => {
    vi.mocked(getPicoraPlan).mockResolvedValueOnce('none');

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), true);

    expect(report.uploaded).toBe(0);
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(kbSyncStore.getState('kb-1').status).toBe('idle');
  });

  it('allows sync for a trial/pro/pro_plus plan', async () => {
    vi.mocked(getPicoraPlan).mockResolvedValueOnce('trial');
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map([['note.md', localEntry('aaa')]]));
    vi.mocked(loadLastManifest).mockResolvedValue(new Map());
    vi.mocked(fetchManifest).mockResolvedValue([]);
    vi.mocked(invoke).mockResolvedValue('# Hello');
    vi.mocked(syncBatch).mockResolvedValue(applied(['note.md']));

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    expect(report.uploaded).toBe(1);
    expect(fetchManifest).toHaveBeenCalledOnce();
  });
});

describe('runSync — error path', () => {
  it('sets kbSyncStore to error state on exception', async () => {
    vi.mocked(buildLocalManifest).mockRejectedValue(new Error('Network failure'));

    await expect(runSync(makeBinding(), makeKb(), makeTarget(), false)).rejects.toThrow('Network failure');

    const state = kbSyncStore.getState('kb-1');
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('Network failure');
  });

  it('handles string errors from invoke', async () => {
    vi.mocked(buildLocalManifest).mockRejectedValue('invoke failed: permission denied');

    await expect(runSync(makeBinding(), makeKb(), makeTarget(), false)).rejects.toBe(
      'invoke failed: permission denied'
    );

    expect(kbSyncStore.getState('kb-1').lastError).toBe('invoke failed: permission denied');
  });

  it('ignores non-.moraya AI-memory dot-namespaces (no download into KB folder)', async () => {
    // Remote has a regular file, a .moraya file, and a .claude/ memory-namespace file.
    const remoteEntries: ManifestEntry[] = [
      { relativePath: 'note.md', sourceHash: 'aaa', sizeBytes: 10, updatedAt: new Date().toISOString() },
      { relativePath: '.moraya/memories/m.md', sourceHash: 'bbb', sizeBytes: 10, updatedAt: new Date().toISOString() },
      { relativePath: '.claude/CLAUDE.md', sourceHash: 'ccc', sizeBytes: 10, updatedAt: new Date().toISOString() },
    ];
    vi.mocked(buildLocalManifest).mockResolvedValue(new Map());
    vi.mocked(loadLastManifest).mockResolvedValue(new Map());
    vi.mocked(fetchManifest).mockResolvedValue(remoteEntries);
    vi.mocked(fetchRaw).mockResolvedValue('# content');
    vi.mocked(invoke).mockResolvedValue(undefined);

    const report = await runSync(makeBinding(), makeKb(), makeTarget(), false);

    // note.md + .moraya/... download; .claude/... is skipped.
    expect(report.downloaded).toBe(2);
    const downloadedPaths = vi.mocked(fetchRaw).mock.calls.map((c) => c[3]);
    expect(downloadedPaths).toContain('note.md');
    expect(downloadedPaths).toContain('.moraya/memories/m.md');
    expect(downloadedPaths).not.toContain('.claude/CLAUDE.md');
  });
});

describe('isMemoryNamespacePath', () => {
  it('flags non-.moraya dot-namespaces', () => {
    expect(isMemoryNamespacePath('.claude/CLAUDE.md')).toBe(true);
    expect(isMemoryNamespacePath('.cursor/rules')).toBe(true);
    expect(isMemoryNamespacePath('.codex/AGENTS.md')).toBe(true);
  });
  it('does not flag .moraya or regular paths', () => {
    expect(isMemoryNamespacePath('.moraya/memories/m.md')).toBe(false);
    expect(isMemoryNamespacePath('note.md')).toBe(false);
    expect(isMemoryNamespacePath('prompts/p.md')).toBe(false);
    expect(isMemoryNamespacePath('docs/.hidden.md')).toBe(false);
  });
});
