<script lang="ts">
	import { t } from '$lib/i18n';
	import { onDestroy } from 'svelte';
	import { reviewStore } from '$lib/services/review/review-store';
	import { createReview } from '$lib/services/review/review-service';
	import { gitHeadCommit, gitGetUserInfo } from '$lib/services/git';
	import type { ResolvedReview, ReviewAnchor } from '$lib/services/review/types';
	import type { KnowledgeBase } from '$lib/stores/files-store';
	import ReviewComment from './ReviewComment.svelte';
	import { triggerReviewCommand } from '$lib/services/ai/ai-service';
	import { aiStore } from '$lib/services/ai/ai-service';
	import { settingsStore } from '$lib/stores/settings-store';
	import { get } from 'svelte/store';

	let {
		kb,
		editorMode = 'visual',
		onJumpToReview,
		onOpenGitBind,
		onShowAIPanel,
	}: {
		kb: KnowledgeBase | null;
		editorMode?: string;
		onJumpToReview?: (reviewId: string) => void;
		onOpenGitBind?: () => void;
		onShowAIPanel?: () => void;
	} = $props();

	// ── Store state ───────────────────────────────────────────────

	let reviews = $state<ResolvedReview[]>([]);
	let loading = $state(false);
	let activeReviewId = $state<string | null>(null);

	const unsub = reviewStore.subscribe((s) => {
		reviews = s.reviews;
		loading = s.loading;
		activeReviewId = s.activeReviewId;
	});
	onDestroy(() => unsub());

	// ── Derived groups ────────────────────────────────────────────

	const openReviews = $derived(
		reviews.filter((r) => r.status === 'open' && r.anchorState !== 'unanchored')
	);
	const relocatedReviews = $derived(
		reviews.filter((r) => r.status === 'open' && r.anchorState === 'relocated')
	);
	const unanchoredReviews = $derived(
		reviews.filter((r) => r.status === 'unanchored')
	);
	const closedReviews = $derived(
		reviews.filter((r) => r.status === 'resolved' || r.status === 'wontfix')
	);

	const openCount = $derived(openReviews.length + relocatedReviews.length + unanchoredReviews.length);

	let showClosed = $state(false);

	// ── User info ─────────────────────────────────────────────────

	let currentUser = $state('');
	let currentUserEmail = $state('');
	let headCommit = $state('');

	$effect(() => {
		if (kb?.path) {
			gitGetUserInfo(kb.path).then((info) => {
				currentUser = info.name || 'Unknown';
				currentUserEmail = info.email || '';
			}).catch(() => {});
			if (kb.git) {
				gitHeadCommit(kb.path).then((h) => { headCommit = h; }).catch(() => {});
			}
		}
	});

	// ── Reanchor mode ─────────────────────────────────────────────

	let reanchoringId = $state<string | null>(null);

	function handleReanchor(reviewId: string) {
		reanchoringId = reviewId;
	}

	/** Called from Editor when user confirms a text selection in reanchor mode. */
	export function confirmReanchor(anchor: ReviewAnchor) {
		if (!reanchoringId) return;
		const id = reanchoringId;
		reanchoringId = null;
		import('$lib/services/review/review-service').then(({ reanchorReview }) => {
			const review = reviews.find((r) => r.id === id);
			if (!review) return;
			const updated = reanchorReview(review, anchor);
			reviewStore.updateReview(id, updated);
		});
	}

	/** True when the panel is in "waiting for text selection" reanchor mode. */
	export function getIsReanchoring(): boolean { return reanchoringId !== null; }

	// ── v0.32.0: AI command triggers + privacy disclaimer ─────────
	let aiBusy = $state(false);
	let aiError = $state('');
	let pendingCommand = $state<null | {
		cmd: 'improve' | 'respond' | 'summary' | 'ai-review';
		ctx?: { reviewId?: string };
	}>(null);

	/**
	 * Run an AI review command after first checking the per-provider consent
	 * (P1 disclaimer). Local-first providers (Ollama / localhost endpoints)
	 * skip the disclaimer entirely.
	 */
	async function runAiCommand(
		cmd: 'improve' | 'respond' | 'summary' | 'ai-review',
		ctx?: { reviewId?: string },
	) {
		if (aiBusy) return;
		const config = aiStore.getActiveConfig();
		if (!config) {
			aiError = $t('ai.notConfigured') || 'AI provider not configured';
			return;
		}
		const isLocal =
			config.provider === 'ollama' ||
			(config.baseUrl ?? '').includes('localhost') ||
			(config.baseUrl ?? '').includes('127.0.0.1');
		const settings = get(settingsStore);
		const consentMap = settings.aiReviewConsent ?? {};
		const consented = isLocal || consentMap[config.id] === true;

		if (!consented) {
			pendingCommand = { cmd, ctx };
			return;
		}
		await executeAiCommand(cmd, ctx);
	}

	async function executeAiCommand(
		cmd: 'improve' | 'respond' | 'summary' | 'ai-review',
		ctx?: { reviewId?: string },
	) {
		aiBusy = true;
		aiError = '';
		onShowAIPanel?.();
		try {
			await triggerReviewCommand(cmd, ctx);
		} catch (e: unknown) {
			aiError = e instanceof Error ? e.message : String(e);
		} finally {
			aiBusy = false;
		}
	}

	let dontAskAgain = $state(true);

	function dismissDisclaimer() {
		pendingCommand = null;
	}

	async function confirmDisclaimer() {
		if (!pendingCommand) return;
		const config = aiStore.getActiveConfig();
		if (config && dontAskAgain) {
			const cur = get(settingsStore).aiReviewConsent ?? {};
			settingsStore.update({
				aiReviewConsent: { ...cur, [config.id]: true },
			});
		}
		const next = pendingCommand;
		pendingCommand = null;
		await executeAiCommand(next.cmd, next.ctx);
	}

	function aiCommandImprove() { void runAiCommand('improve'); }
	function aiCommandSummary() { void runAiCommand('summary'); }
	function aiCommandReview()  { void runAiCommand('ai-review'); }

	const activeProviderLabel = $derived.by(() => {
		const c = aiStore.getActiveConfig();
		if (!c) return '';
		return `${c.provider} · ${c.model}`;
	});
</script>

<div class="review-panel">
	<!-- v0.32.0: AI command bar -->
	{#if kb?.git}
		<div class="ai-bar">
			<button class="ai-btn" disabled={aiBusy} onclick={aiCommandReview}>
				{#if aiBusy}⟳{:else}✨{/if} {$t('review.aiReview')}
			</button>
			<button class="ai-btn" disabled={aiBusy || openCount === 0} onclick={aiCommandImprove}>
				📝 {$t('review.aiImprove')}
			</button>
			<button class="ai-btn" disabled={aiBusy || reviews.length === 0} onclick={aiCommandSummary}>
				📊 {$t('review.aiSummary')}
			</button>
		</div>
		{#if aiBusy}
			<div class="ai-progress" role="status" aria-live="polite">
				⏳ {$t('review.aiInProgress')}
			</div>
		{/if}
		{#if aiError}
			<div class="ai-error" role="alert">⚠ {aiError}</div>
		{/if}
	{/if}

	<!-- Source mode notice -->
	{#if editorMode !== 'visual'}
		<div class="notice source-mode-notice">
			{$t('review.sourceModeLimitHint')}
		</div>
	{/if}

	<!-- Not git-bound -->
	{#if !kb?.git}
		<div class="empty-state">
			<p>{$t('review.notGitBound')}</p>
			<p class="hint">{$t('review.notGitBoundHint')}</p>
			{#if onOpenGitBind}
				<button class="bind-btn" onclick={onOpenGitBind}>{$t('review.bindGitBtn')}</button>
			{/if}
		</div>

	<!-- Loading -->
	{:else if loading}
		<div class="loading">...</div>

	<!-- No reviews -->
	{:else if reviews.length === 0}
		<div class="empty-state">
			<p>{$t('review.noReviews')}</p>
			<p class="hint">{$t('review.noReviewsHint')}</p>
		</div>

	<!-- Review list -->
	{:else}
		<div class="review-list">
			<!-- Reanchor mode banner -->
			{#if reanchoringId}
				<div class="notice reanchor-notice">
					{$t('review.reanchor')} — select text in editor
					<button class="link-btn" onclick={() => { reanchoringId = null; }}>
						{$t('common.cancel')}
					</button>
				</div>
			{/if}

			<!-- Open reviews -->
			{#each openReviews as review (review.id)}
				<ReviewComment
					{review}
					{currentUser}
					{currentUserEmail}
					{headCommit}
					onJump={onJumpToReview}
					onReanchor={handleReanchor}
					onAiRespond={(id) => runAiCommand('respond', { reviewId: id })}
				/>
			{/each}

			<!-- Relocated reviews (mixed into open list with badge) -->

			<!-- Unanchored group -->
			{#if unanchoredReviews.length > 0}
				<div class="group-header unanchored-header">{$t('review.unanchored')}</div>
				{#each unanchoredReviews as review (review.id)}
					<ReviewComment
						{review}
						{currentUser}
						{currentUserEmail}
						{headCommit}
						onJump={onJumpToReview}
						onReanchor={handleReanchor}
						onAiRespond={(id) => runAiCommand('respond', { reviewId: id })}
					/>
				{/each}
			{/if}

			<!-- Closed (resolved / wontfix) collapsible -->
			{#if closedReviews.length > 0}
				<button
					class="group-toggle"
					onclick={() => { showClosed = !showClosed; }}
				>
					{showClosed ? '▼' : '▶'}
					{$t('review.resolvedCount')} ({closedReviews.length})
				</button>
				{#if showClosed}
					{#each closedReviews as review (review.id)}
						<ReviewComment
							{review}
							{currentUser}
							{currentUserEmail}
							{headCommit}
							onJump={onJumpToReview}
							onReanchor={handleReanchor}
						/>
					{/each}
				{/if}
			{/if}
		</div>
	{/if}
</div>

<!-- v0.32.0: AI Review privacy disclaimer modal -->
{#if pendingCommand}
	<div
		class="disclaimer-overlay"
		role="presentation"
		onclick={dismissDisclaimer}
		onkeydown={(e) => e.key === 'Escape' && dismissDisclaimer()}
	>
		<div
			class="disclaimer-card"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			aria-label={$t('review.aiDisclaimerTitle')}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<h3>⚠ {$t('review.aiDisclaimerTitle')}</h3>
			<p>{$t('review.aiDisclaimerBody')}</p>
			<p class="provider-line">{activeProviderLabel}</p>
			<p class="muted">{$t('review.aiDisclaimerBodyDetails')}</p>
			<p class="muted small">{$t('review.aiDisclaimerLocalHint')}</p>
			<label class="dont-ask">
				<input type="checkbox" bind:checked={dontAskAgain} />
				<span>{$t('review.aiDisclaimerDontAsk')}</span>
			</label>
			<div class="disclaimer-actions">
				<button class="ghost-btn" onclick={dismissDisclaimer}>
					{$t('common.cancel')}
				</button>
				<button class="primary-btn" onclick={confirmDisclaimer}>
					{$t('review.aiDisclaimerConfirm')}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.review-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		font-size: var(--font-size-sm);
	}

	.review-list {
		flex: 1;
		overflow-y: auto;
	}

	.empty-state {
		padding: 24px 16px;
		text-align: center;
		color: var(--color-text-muted);
	}
	.empty-state p {
		margin: 0 0 6px;
	}
	.empty-state .hint {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		opacity: 0.8;
	}

	.bind-btn {
		margin-top: 10px;
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--color-accent);
		background: transparent;
		color: var(--color-accent);
		cursor: pointer;
		font-size: var(--font-size-sm);
	}
	.bind-btn:hover { background: rgba(var(--color-accent-rgb), 0.08); }

	.loading {
		padding: 24px;
		text-align: center;
		color: var(--color-text-muted);
	}

	.notice {
		padding: 8px 12px;
		font-size: var(--font-size-xs);
		border-bottom: 1px solid var(--color-border);
	}
	.source-mode-notice {
		background: rgba(148, 163, 184, 0.1);
		color: var(--color-text-muted);
	}
	.reanchor-notice {
		background: rgba(59, 130, 246, 0.08);
		color: var(--color-accent);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--color-accent);
		cursor: pointer;
		font-size: inherit;
		text-decoration: underline;
	}

	.group-header {
		padding: 6px 12px;
		font-size: var(--font-size-xs);
		font-weight: 600;
		color: var(--color-text-muted);
		background: var(--color-surface-alt, var(--color-hover));
		border-bottom: 1px solid var(--color-border);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.unanchored-header {
		color: #dc2626;
	}

	.group-toggle {
		width: 100%;
		text-align: left;
		padding: 8px 12px;
		font-size: var(--font-size-xs);
		font-weight: 600;
		color: var(--color-text-muted);
		background: var(--color-surface-alt, var(--color-hover));
		border: none;
		border-top: 1px solid var(--color-border);
		cursor: pointer;
	}
	.group-toggle:hover { background: var(--color-hover); }

	/* v0.32.0: AI command bar */
	.ai-bar {
		display: flex;
		gap: 6px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
		flex-wrap: wrap;
	}
	.ai-btn {
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-bg);
		color: var(--color-text);
		cursor: pointer;
		font-size: var(--font-size-xs);
	}
	.ai-btn:hover { background: var(--color-hover); }
	.ai-btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.ai-progress {
		padding: 6px 12px;
		font-size: var(--font-size-xs);
		color: var(--color-accent);
		background: rgba(99, 102, 241, 0.08);
		border-bottom: 1px solid var(--color-border);
	}
	.ai-error {
		padding: 6px 12px;
		font-size: var(--font-size-xs);
		color: #dc2626;
		background: rgba(239, 68, 68, 0.08);
		border-bottom: 1px solid var(--color-border);
	}

	/* v0.32.0: Disclaimer modal */
	.disclaimer-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.disclaimer-card {
		background: var(--color-bg);
		color: var(--color-text);
		padding: 20px;
		border-radius: 8px;
		max-width: 480px;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
	}
	.disclaimer-card h3 {
		margin: 0 0 12px;
		font-size: var(--font-size-base);
	}
	.disclaimer-card p {
		margin: 8px 0;
		font-size: var(--font-size-sm);
		line-height: 1.5;
	}
	.provider-line {
		font-family: var(--font-family-mono);
		background: var(--color-surface);
		padding: 6px 10px;
		border-radius: 4px;
	}
	.muted { color: var(--color-text-muted); }
	.small { font-size: var(--font-size-xs) !important; }
	.dont-ask {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 12px 0;
		font-size: var(--font-size-sm);
		cursor: pointer;
	}
	.disclaimer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	.ghost-btn, .primary-btn {
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		font-size: var(--font-size-sm);
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		color: var(--color-text);
	}
	.ghost-btn:hover { background: var(--color-hover); }
	.primary-btn {
		background: var(--color-accent);
		color: #fff;
		border-color: var(--color-accent);
	}
	.primary-btn:hover { opacity: 0.9; }
</style>
