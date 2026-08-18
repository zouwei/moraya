<script lang="ts">
	/**
	 * HistoryPanel.svelte (v0.32.0) — file commit timeline + snapshot + audit export.
	 *
	 * Modes:
	 *   - 'list'     → commit timeline (default)
	 *   - 'snapshot' → read-only snapshot view of a specific commit
	 *
	 * Diff is opened by parent via `onOpenDiff()` callback (parent mounts DiffView
	 * as a full-overlay; this panel doesn't manage that overlay itself).
	 *
	 * Blame toggle is a parent-controlled state; this panel just emits the flip.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { t } from '$lib/i18n';
	import { gitLog, gitShowFile, type GitLogEntry } from '$lib/services/git';
	import { reviewStore } from '$lib/services/review/review-store';
	import { editorStore } from '$lib/stores/editor-store';
	import type { ResolvedReview } from '$lib/services/review/types';
	import type { KnowledgeBase } from '$lib/stores/files-store';
	import { invoke } from '@tauri-apps/api/core';
	import { save } from '$lib/utils/native-dialog';

	// v0.32.1 §F5: module-level commit cache, persists across HistoryPanel mounts
	const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
	const historyCache = new Map<
		string,
		{ entries: GitLogEntry[]; cachedAt: number }
	>();
	function cacheKey(kbPath: string, rel: string): string {
		return `${kbPath}::${rel}`;
	}
	/** Invalidate the cached entries for a single file (called on save). */
	export function invalidateHistoryCache(kbPath: string, rel: string): void {
		historyCache.delete(cacheKey(kbPath, rel));
	}

	let {
		kb,
		filePath,
		editorMode = 'visual',
		showBlame = false,
		onOpenDiff,
		onToggleBlame,
		onOpenGitBind,
	}: {
		kb: KnowledgeBase | null;
		filePath: string | null;
		editorMode?: string;
		showBlame?: boolean;
		onOpenDiff?: (
			leftHash: string | null,
			rightHash: string | null,
		) => void;
		onToggleBlame?: () => void;
		onOpenGitBind?: () => void;
	} = $props();

	// ── State ────────────────────────────────────────────────────────
	let commits = $state<GitLogEntry[]>([]);
	let loading = $state(false);
	let errorMessage = $state('');

	// snapshot mode
	let mode = $state<'list' | 'snapshot'>('list');
	let snapshotCommit = $state<GitLogEntry | null>(null);
	let snapshotContent = $state('');
	let snapshotLoading = $state(false);

	// reviews subscription for export
	let reviews = $state<ResolvedReview[]>([]);
	const unsubReviews = reviewStore.subscribe((s) => {
		reviews = s.reviews;
	});

	// v0.32.1 §F5: invalidate cache when current file is saved (dirty: true → false)
	let prevDirty = false;
	const unsubEditor = editorStore.subscribe((s) => {
		if (prevDirty && !s.isDirty && kb && filePath && filePath.startsWith(kb.path)) {
			const rel = filePath.slice(kb.path.length).replace(/^\//, '');
			invalidateHistoryCache(kb.path, rel);
			// Force a refresh on next loadCommits
			void loadCommits();
		}
		prevDirty = s.isDirty;
	});

	// v0.32.1 §F8: keyboard navigation focus index
	let focusedIndex = $state(0);
	let listEl = $state<HTMLUListElement | undefined>();

	const isGitBound = $derived(!!kb && !!kb.git);
	const relPath = $derived.by(() => {
		if (!kb || !filePath) return '';
		const root = kb.path.replace(/\\/g, '/').replace(/\/$/, '');
		const fp = filePath.replace(/\\/g, '/');
		if (fp.startsWith(root)) return fp.slice(root.length).replace(/^\//, '');
		return '';
	});

	const fileName = $derived.by(() => {
		const segments = relPath.split('/');
		return segments[segments.length - 1] || '';
	});

	// ── Loaders ──────────────────────────────────────────────────────
	async function loadCommits() {
		if (!kb || !filePath || !isGitBound) {
			commits = [];
			return;
		}
		const key = cacheKey(kb.path, relPath);
		const cached = historyCache.get(key);
		// v0.32.1 §F5: serve cache while still fresh; refresh in background
		if (cached && Date.now() - cached.cachedAt < HISTORY_CACHE_TTL_MS) {
			commits = cached.entries;
			loading = false;
			errorMessage = '';
			// Background refresh: silently update if anything changed
			void (async () => {
				try {
					const fresh = await gitLog(kb.path, relPath, 50);
					historyCache.set(key, { entries: fresh, cachedAt: Date.now() });
					// Replace only if visibly different to avoid jitter
					if (JSON.stringify(fresh) !== JSON.stringify(cached.entries)) {
						commits = fresh;
					}
				} catch {
					/* swallow background refresh errors */
				}
			})();
			return;
		}
		loading = true;
		errorMessage = '';
		try {
			const entries = await gitLog(kb.path, relPath, 50);
			commits = entries;
			historyCache.set(key, { entries, cachedAt: Date.now() });
		} catch (e: unknown) {
			errorMessage = e instanceof Error ? e.message : String(e);
			commits = [];
		} finally {
			loading = false;
		}
	}

	async function loadSnapshot(commit: GitLogEntry) {
		if (!kb) return;
		snapshotCommit = commit;
		snapshotLoading = true;
		mode = 'snapshot';
		try {
			const content = await gitShowFile(kb.path, commit.hash, relPath);
			snapshotContent = content;
		} catch (e: unknown) {
			errorMessage = e instanceof Error ? e.message : String(e);
			snapshotContent = '';
		} finally {
			snapshotLoading = false;
		}
	}

	function backToList() {
		mode = 'list';
		snapshotCommit = null;
		snapshotContent = '';
	}

	function compareWithCurrent(commit: GitLogEntry) {
		// leftHash = the older snapshot, rightHash = null (working tree)
		onOpenDiff?.(commit.hash, null);
	}

	function compareWithPrev(commit: GitLogEntry, idx: number) {
		const next = commits[idx + 1];
		if (!next) return;
		onOpenDiff?.(next.hash, commit.hash);
	}

	function copySnapshot() {
		try {
			void navigator.clipboard.writeText(snapshotContent);
		} catch {
			/* no-op */
		}
	}

	// ── Audit report export ──────────────────────────────────────────
	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function buildReport(opts: {
		anonymize: boolean;
	}): string {
		const lines: string[] = [];
		lines.push(`# ${$t('audit.report_title', { filename: fileName })}`);
		lines.push('');
		const now = new Date().toISOString();
		lines.push(`${$t('audit.generated_at')}: ${now}`);
		lines.push(`${$t('audit.knowledge_base')}: ${kb?.path ?? ''}`);
		if (kb?.git) {
			lines.push(
				`${$t('audit.git_repo')}: ${kb.git.remoteUrl} (${$t('audit.branch')} ${kb.git.branch})`,
			);
		} else {
			lines.push(`${$t('audit.not_git_bound')}`);
		}
		lines.push('');

		// Commit history
		lines.push(`## ${$t('audit.commit_history')}`);
		lines.push('');
		if (commits.length === 0) {
			lines.push($t('audit.not_git_bound'));
		} else {
			lines.push(
				`| ${$t('audit.col_time')} | ${$t('audit.col_author')} | ${$t('audit.col_summary')} |`,
			);
			lines.push('|---|---|---|');
			// Optional anonymization: build an alias map per author name
			const authorAlias = new Map<string, string>();
			let aliasCounter = 0;
			const aliasFor = (name: string) => {
				if (!opts.anonymize) return name;
				if (!authorAlias.has(name)) {
					aliasCounter++;
					authorAlias.set(name, `reviewer-${aliasCounter}`);
				}
				return authorAlias.get(name) ?? name;
			};
			for (const c of commits) {
				const date = formatDate(c.date);
				const author = aliasFor(c.author);
				const summary = c.message.replace(/\|/g, '\\|');
				lines.push(`| ${date} | @${author} | ${summary} |`);
			}
			if (commits.length >= 50) {
				lines.push('');
				lines.push(`_${$t('audit.showing_last_commits', { count: '50' })}_`);
			}
		}
		lines.push('');

		// Review summary
		lines.push(`## ${$t('audit.review_summary')}`);
		lines.push('');
		if (reviews.length === 0) {
			lines.push($t('audit.no_reviews'));
		} else {
			const resolved = reviews.filter((r) => r.status === 'resolved');
			const wontfix = reviews.filter((r) => r.status === 'wontfix');
			const open = reviews.filter(
				(r) => r.status === 'open' || r.status === 'unanchored',
			);
			lines.push(
				$t('audit.summary_stats', {
					total: String(reviews.length),
					resolved: String(resolved.length),
					wontfix: String(wontfix.length),
					open: String(open.length),
				}),
			);
			lines.push('');

			const reviewAuthorAlias = new Map<string, string>();
			let raliasCounter = 0;
			const aliasFor = (name: string) => {
				if (!opts.anonymize) return name;
				if (!reviewAuthorAlias.has(name)) {
					raliasCounter++;
					reviewAuthorAlias.set(name, `reviewer-${raliasCounter}`);
				}
				return reviewAuthorAlias.get(name) ?? name;
			};

			const sectionFor = (
				title: string,
				items: ResolvedReview[],
				resolvedSection: boolean,
				resolvedNoteKey: string,
			) => {
				if (items.length === 0) return;
				lines.push(`### ${title}`);
				for (const r of items) {
					const lineNum = r.anchor?.originalLine ?? 0;
					const author = aliasFor(r.author || 'reviewer');
					const text = (r.comments?.[0]?.text ?? '').replace(/\n/g, ' ');
					const lineLabel =
						lineNum > 0
							? $t('audit.line_n', { n: String(lineNum) })
							: $t('audit.unanchored_label');
					if (resolvedSection && r.resolvedAt && r.resolvedBy) {
						const note = $t(resolvedNoteKey, {
							date: formatDate(r.resolvedAt),
							user: aliasFor(r.resolvedBy),
						});
						lines.push(`- [${lineLabel}] @${author}: ${text} → ${note}`);
					} else {
						lines.push(`- [${lineLabel}] @${author}: ${text}`);
					}
				}
				lines.push('');
			};

			sectionFor(
				$t('audit.resolved_section', { count: String(resolved.length) }),
				resolved,
				true,
				'audit.resolved_note',
			);
			sectionFor(
				$t('audit.wontfix_section', { count: String(wontfix.length) }),
				wontfix,
				true,
				'audit.wontfix_note',
			);
			sectionFor(
				$t('audit.open_section', { count: String(open.length) }),
				open,
				false,
				'',
			);
		}
		return lines.join('\n');
	}

	let exporting = $state(false);
	let anonymize = $state(false);

	async function exportReport() {
		if (exporting) return;
		exporting = true;
		try {
			const today = new Date().toISOString().slice(0, 10);
			const defaultName = `audit-${today}.md`;
			const targetPath = await save({
				defaultPath: kb ? `${kb.path}/${defaultName}` : defaultName,
				filters: [{ name: 'Markdown', extensions: ['md'] }],
			});
			if (!targetPath) return;
			const content = buildReport({ anonymize });
			await invoke('write_file', { path: targetPath, content });
		} catch (e: unknown) {
			errorMessage = e instanceof Error ? e.message : String(e);
		} finally {
			exporting = false;
		}
	}

	// ── Effects ──────────────────────────────────────────────────────
	onMount(loadCommits);
	$effect(() => {
		// Re-load on file / kb changes
		void filePath;
		void kb?.id;
		void kb?.git;
		mode = 'list';
		void loadCommits();
	});

	onDestroy(() => {
		unsubReviews();
		unsubEditor();
	});

	// v0.32.1 §F8: keyboard navigation handler
	function handleListKeydown(e: KeyboardEvent) {
		if (mode !== 'list' || commits.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			focusedIndex = Math.min(focusedIndex + 1, commits.length - 1);
			scrollFocusedIntoView();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			focusedIndex = Math.max(focusedIndex - 1, 0);
			scrollFocusedIntoView();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const c = commits[focusedIndex];
			if (c) void loadSnapshot(c);
		} else if (e.key === 'c' || e.key === 'C') {
			e.preventDefault();
			const c = commits[focusedIndex];
			if (!c) return;
			if (focusedIndex === 0) compareWithCurrent(c);
			else if (focusedIndex < commits.length - 1) compareWithPrev(c, focusedIndex);
		}
	}

	function scrollFocusedIntoView() {
		if (!listEl) return;
		const item = listEl.children[focusedIndex] as HTMLElement | undefined;
		item?.scrollIntoView({ block: 'nearest' });
	}
</script>

<div class="history-panel">
	<!-- Toolbar -->
	<div class="toolbar">
		{#if mode === 'snapshot'}
			<button class="btn" onclick={backToList}>
				{$t('history.back_to_list')}
			</button>
			<span class="title">
				{$t('history.snapshot.label', { hash: snapshotCommit?.short_hash ?? '' })}
				· @{snapshotCommit?.author ?? ''}
				· {formatDate(snapshotCommit?.date ?? '')}
			</span>
		{:else}
			<span class="title">
				{$t('history.title', { filename: fileName || '—' })}
			</span>
			<button class="btn" disabled={!isGitBound || commits.length === 0 || exporting}
				onclick={exportReport}>
				📤 {$t('history.export_btn')}
			</button>
		{/if}
	</div>

	<!-- States -->
	{#if mode === 'snapshot'}
		<div class="snapshot-notice">ⓘ {$t('history.snapshot.notice')}</div>
		{#if snapshotLoading}
			<div class="state">⟳ {$t('history.loading')}</div>
		{:else}
			<pre class="snapshot-body" tabindex="0">{snapshotContent}</pre>
			<div class="snapshot-actions">
				<button class="btn" onclick={copySnapshot}>📋 {$t('history.snapshot.copy')}</button>
				{#if snapshotCommit}
					<button class="btn" onclick={() => snapshotCommit && compareWithCurrent(snapshotCommit)}>
						⚖ {$t('history.snapshot.compare')}
					</button>
				{/if}
			</div>
		{/if}
	{:else if !isGitBound}
		<div class="empty-state">
			<div class="empty-icon">📁</div>
			<div class="empty-title">{$t('history.empty.no_git')}</div>
			<div class="empty-hint">{$t('history.empty.no_git_hint')}</div>
			{#if onOpenGitBind}
				<button class="btn primary" onclick={onOpenGitBind}>
					{$t('history.empty.no_git_action')}
				</button>
			{/if}
		</div>
	{:else if loading}
		<div class="state">⟳ {$t('history.loading')}</div>
	{:else if errorMessage}
		<div class="empty-state">
			<div class="empty-icon">⚠</div>
			<div class="empty-title">{$t('history.empty.error')}</div>
			<div class="empty-hint">{errorMessage}</div>
			<button class="btn" onclick={loadCommits}>
				{$t('history.empty.error_retry')}
			</button>
		</div>
	{:else if commits.length === 0}
		<div class="empty-state">
			<div class="empty-icon">📝</div>
			<div class="empty-title">{$t('history.empty.no_commits')}</div>
			<div class="empty-hint">{$t('history.empty.no_commits_hint')}</div>
		</div>
	{:else}
		<!-- Timeline -->
		<ul
			class="timeline"
			role="listbox"
			aria-label={$t('history.tab_label')}
			tabindex="0"
			bind:this={listEl}
			onkeydown={handleListKeydown}
		>
			{#each commits as commit, idx (commit.hash)}
				<li
					class="timeline-item"
					class:focused={idx === focusedIndex}
					role="option"
					aria-selected={idx === focusedIndex}
					aria-label={`${commit.author} ${formatDate(commit.date)}: ${commit.message}`}
					onclick={() => { focusedIndex = idx; }}
					onkeydown={(e) => { if (e.key === 'Enter') void loadSnapshot(commit); }}
				>
					<div class="commit-line">
						<span class="dot">●</span>
						<span class="hash">{commit.short_hash}</span>
						<span class="date">{formatDate(commit.date)}</span>
					</div>
					<div class="author-line">@{commit.author}</div>
					<div class="msg">{commit.message}</div>
					{#if commit.renamed_from}
						<div class="renamed-from">
							{$t('history.renamed_from', { oldPath: commit.renamed_from })}
						</div>
					{/if}
					<div class="commit-actions">
						<button class="link-btn" onclick={() => loadSnapshot(commit)}>
							👁 {$t('history.view_snapshot')}
						</button>
						{#if idx === 0}
							<!-- top: always offer compare with current (working tree) -->
							<button class="link-btn" onclick={() => compareWithCurrent(commit)}>
								⚖ {$t('history.compare_with_current')}
							</button>
						{:else if idx < commits.length - 1}
							<button class="link-btn" onclick={() => compareWithPrev(commit, idx)}>
								⚖ {$t('history.compare_with_prev')}
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>

		{#if commits.length >= 50}
			<div class="footer-note">{$t('history.showing_last', { count: '50' })}</div>
		{/if}

		<!-- Blame toggle -->
		{#if onToggleBlame}
			<div class="blame-row">
				<label>
					<input
						type="checkbox"
						checked={showBlame}
						disabled={editorMode !== 'source'}
						onchange={() => onToggleBlame?.()}
					/>
					<span>{$t('history.blame_toggle')}</span>
				</label>
				{#if editorMode !== 'source'}
					<span class="blame-hint">{$t('history.blame_not_supported_visual')}</span>
				{/if}
			</div>
		{/if}

		<!-- Anonymize toggle for export -->
		<div class="anon-row">
			<label>
				<input type="checkbox" bind:checked={anonymize} />
				<span>{$t('audit.anonymize_authors', { name: 'zouwei' })}</span>
			</label>
		</div>
	{/if}
</div>

<style>
	.history-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		font-size: var(--font-size-sm);
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
		flex-shrink: 0;
	}
	.title {
		flex: 1;
		font-weight: 600;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.btn {
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-bg);
		color: var(--color-text);
		cursor: pointer;
		font-size: var(--font-size-sm);
	}
	.btn:hover { background: var(--color-hover); }
	.btn.primary {
		background: var(--color-accent);
		color: #fff;
		border-color: var(--color-accent);
	}
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.state, .empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 32px 16px;
		color: var(--color-text-muted);
		text-align: center;
	}
	.empty-icon {
		font-size: 32px;
		opacity: 0.5;
	}
	.empty-title {
		font-size: var(--font-size-base);
		font-weight: 600;
		color: var(--color-text);
	}
	.empty-hint {
		font-size: var(--font-size-xs);
	}

	.timeline {
		list-style: none;
		margin: 0;
		padding: 8px 0;
		flex: 1;
		overflow-y: auto;
	}
	.timeline-item {
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		cursor: pointer;
	}
	.timeline-item.focused {
		background: var(--color-hover);
		border-left: 3px solid var(--color-accent);
		padding-left: 9px;
	}
	.timeline-item:focus,
	.timeline:focus { outline: none; }
	.renamed-from {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		font-style: italic;
		margin: 2px 0;
	}
	.commit-line {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.dot { color: var(--color-accent); }
	.hash {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}
	.date {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		margin-left: auto;
	}
	.author-line {
		font-weight: 600;
		font-size: var(--font-size-xs);
		color: var(--color-text);
		margin-top: 2px;
	}
	.msg {
		font-size: var(--font-size-sm);
		color: var(--color-text);
		margin: 4px 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.commit-actions {
		display: flex;
		gap: 8px;
		margin-top: 4px;
		flex-wrap: wrap;
	}
	.link-btn {
		background: none;
		border: none;
		padding: 2px 4px;
		color: var(--color-accent);
		cursor: pointer;
		font-size: var(--font-size-xs);
	}
	.link-btn:hover { text-decoration: underline; }

	.footer-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		text-align: center;
		padding: 4px;
	}

	.blame-row, .anon-row {
		padding: 8px 12px;
		border-top: 1px solid var(--color-border);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.blame-row label, .anon-row label {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
	.blame-hint {
		color: var(--color-text-muted);
		font-style: italic;
	}

	.snapshot-notice {
		padding: 6px 12px;
		background: rgba(99, 102, 241, 0.08);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		border-bottom: 1px solid var(--color-border);
	}
	.snapshot-body {
		flex: 1;
		overflow: auto;
		padding: 12px;
		margin: 0;
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--color-text);
		background: var(--color-bg);
	}
	.snapshot-actions {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		border-top: 1px solid var(--color-border);
		background: var(--color-surface);
		flex-shrink: 0;
	}
</style>
