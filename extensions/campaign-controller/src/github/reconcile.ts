/**
 * Read-only upstream PR reconciliation (warren-323d, plan pl-91b6 step 9).
 *
 * Reconciles one already-known upstream pull-request identity against
 * authoritative GitHub state. Participating notifications are fetched as
 * wake-ups only — their content never feeds controller decisions (plan risk
 * 3); every fact comes from a GET/HEAD re-read of the PR, its reviews, its
 * issue and review comments, its check runs, and its combined status.
 *
 * Observed facts are normalized into durable source events keyed by
 * `repository | event kind | node id`, so reordered pagination, replayed
 * notifications, and controller restarts deliver each fact exactly once. An
 * upstream *edit* of the same node id updates the stored payload in place
 * instead of forking a second event.
 *
 * Attention items are derived deterministically for every category the plan
 * names: requested changes, actionable maintainer comments, failing checks,
 * policy-relevant PR edits, human takeover, stale author action, unresolved
 * ambiguity, and a vanished upstream PR. They dedupe on
 * `reason + dedupeKey`, so repeated ticks stay stable. Comment and review
 * text is carried as untrusted data and is never parsed for commands, and
 * nothing here can mutate GitHub — the client exposes reads only.
 */

import type { Clock } from "../clock.ts";
import { canonicalJson } from "../digest.ts";
import type { AttentionItemRow } from "../store/types.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import { GithubApiError } from "./errors.ts";
import { ReadOnlyGithubClient } from "./client.ts";
import type {
	GithubConditionalHeaders,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "./types.ts";

/** Attention reasons the reconciler derives (design record §10.1). */
export type ReconcileAttentionReason =
	| "review_changes_requested"
	| "maintainer_comment"
	| "failing_checks"
	| "policy_change"
	| "human_takeover"
	| "stale_author_action"
	| "unresolved_ambiguity"
	| "upstream_pr_missing";

/** The already-known upstream PR identity to reconcile. */
export interface ReconcileTarget {
	campaignId: string;
	upstreamOwner: string;
	upstreamRepo: string;
	prNumber: number;
	/** The bot account's login; its own activity is never an attention item. */
	botLogin: string;
	/** Optional work-item link stamped onto derived attention items. */
	workItemId?: string | null;
	/** Flag the PR as stale after this much upstream inactivity (ms). */
	staleAfterMs?: number;
}

/** Result of one reconciliation tick. */
export interface ReconcileSummary {
	repository: string;
	prNumber: number;
	/** True when the upstream PR answered 404 (deleted or made invisible). */
	prMissing: boolean;
	/** Participating notifications matching this PR — wake-ups only. */
	wakeUps: number;
	newEvents: number;
	duplicateEvents: number;
	editedEvents: number;
	/** Attention items added this tick (already deduplicated). */
	attentionAdded: AttentionItemRow[];
}

export interface UpstreamPrReconcilerDeps {
	client: ReadOnlyGithubClient;
	store: CampaignStateStore;
	clock: Clock;
}

interface PrCursor {
	etag: string | null;
	lastModified: string | null;
	snapshot: GithubPullRequestSnapshot | null;
	lastActivityMs: number;
}

interface ValidatorsCursor {
	etag: string | null;
	lastModified: string | null;
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export class UpstreamPrReconciler {
	readonly #client: ReadOnlyGithubClient;
	readonly #store: CampaignStateStore;
	readonly #clock: Clock;

	constructor(deps: UpstreamPrReconcilerDeps) {
		this.#client = deps.client;
		this.#store = deps.store;
		this.#clock = deps.clock;
	}

	/** Run one read-only reconciliation tick for one known PR identity. */
	async reconcile(target: ReconcileTarget): Promise<ReconcileSummary> {
		const repository = `${target.upstreamOwner}/${target.upstreamRepo}`;
		const tick: TickState = {
			target,
			repository,
			newEvents: 0,
			duplicateEvents: 0,
			editedEvents: 0,
			attentionAdded: [],
			lastActivityMs: 0,
		};
		await this.#pollWakeUps(tick);
		const snapshot = await this.#reconcilePullRequest(tick);
		if (snapshot !== null) {
			await this.#reconcileReviews(tick, snapshot);
			await this.#reconcileIssueComments(tick);
			await this.#reconcileReviewComments(tick, snapshot);
			await this.#reconcileChecks(tick, snapshot);
			this.#deriveStaleness(tick, snapshot);
		}
		return {
			repository,
			prNumber: target.prNumber,
			prMissing: tick.prMissing,
			wakeUps: tick.wakeUps,
			newEvents: tick.newEvents,
			duplicateEvents: tick.duplicateEvents,
			editedEvents: tick.editedEvents,
			attentionAdded: tick.attentionAdded,
		};
	}

	/**
	 * Participating notifications are wake-ups and nothing more: the list is
	 * read (conditionally), counted against this PR, and discarded. No
	 * notification field ever becomes controller state.
	 */
	async #pollWakeUps(tick: TickState): Promise<void> {
		const key = `notifications|${tick.repository}`;
		const cursor = this.#store.cursors.get<ValidatorsCursor>(key);
		try {
			const page = await this.#client.listNotifications({
				participating: true,
				etag: cursor?.etag ?? undefined,
				lastModified: cursor?.lastModified ?? undefined,
			});
			tick.wakeUps = page.items.filter(
				(item) =>
					item.repositoryFullName === tick.repository &&
					item.subjectType === "PullRequest" &&
					item.subjectUrl.endsWith(`/pulls/${tick.target.prNumber}`),
			).length;
			this.#store.cursors.set(key, {
				etag: page.etag,
				lastModified: page.lastModified,
			});
		} catch (error) {
			this.#ambiguity(tick, "notifications", describeError(error));
		}
	}

	/** Authoritative PR state; returns null when the PR is missing or unreadable. */
	async #reconcilePullRequest(tick: TickState): Promise<GithubPullRequestSnapshot | null> {
		const key = `pr|${tick.repository}|${tick.target.prNumber}`;
		const cursor = this.#store.cursors.get<PrCursor>(key);
		try {
			const result = await this.#client.getPullRequest(
				tick.target.upstreamOwner,
				tick.target.upstreamRepo,
				tick.target.prNumber,
				validatorsOf(cursor),
			);
			if (result.notModified) {
				return cursor?.snapshot ?? null;
			}
			const snapshot = result.data;
			this.#store.cursors.set(key, {
				etag: result.etag,
				lastModified: result.lastModified,
				snapshot,
				lastActivityMs: Date.parse(snapshot.updatedAt) || this.#clock.nowMs(),
			});
			this.#recordPrState(tick, snapshot, cursor?.snapshot ?? null);
			return snapshot;
		} catch (error) {
			if (error instanceof GithubApiError && error.status === 404) {
				tick.prMissing = true;
				this.#addAttention(tick, "upstream_pr_missing", `pr-${tick.target.prNumber}`, {
					prNumber: tick.target.prNumber,
				});
				return null;
			}
			this.#ambiguity(tick, key, describeError(error));
			return null;
		}
	}

	/** Normalize the PR snapshot into one durable `pr_state` event. */
	#recordPrState(
		tick: TickState,
		snapshot: GithubPullRequestSnapshot,
		prior: GithubPullRequestSnapshot | null,
	): void {
		const outcome = this.#ingest(tick, "pr_state", snapshot.nodeId, {
			repository: tick.repository,
			eventKind: "pr_state",
			nodeId: snapshot.nodeId,
			number: snapshot.number,
			state: snapshot.state,
			draft: snapshot.draft,
			title: snapshot.title,
			authorLogin: snapshot.authorLogin,
			authorAssociation: snapshot.authorAssociation,
			headRef: snapshot.headRef,
			headSha: snapshot.headSha,
			headRepoFullName: snapshot.headRepoFullName,
			baseRef: snapshot.baseRef,
			baseRepoFullName: snapshot.baseRepoFullName,
			mergedAt: snapshot.mergedAt,
			closedAt: snapshot.closedAt,
			updatedAt: snapshot.updatedAt,
			htmlUrl: snapshot.htmlUrl,
		});
		if (outcome === "edited" && prior !== null) {
			this.#flagPolicyChange(tick, prior, snapshot);
		}
		this.#flagTakeover(tick, snapshot);
	}

	/** A policy-relevant PR edit (title, head ref, head sha, state) needs a human. */
	#flagPolicyChange(
		tick: TickState,
		prior: GithubPullRequestSnapshot,
		snapshot: GithubPullRequestSnapshot,
	): void {
		const changed: string[] = [];
		if (prior.title !== snapshot.title) changed.push("title");
		if (prior.headRef !== snapshot.headRef) changed.push("headRef");
		if (prior.headSha !== snapshot.headSha) changed.push("headSha");
		if (prior.state !== snapshot.state) changed.push("state");
		if (changed.length === 0) return;
		this.#addAttention(tick, "policy_change", `${snapshot.nodeId}:${changed.join("+")}`, {
			prNumber: snapshot.number,
			changed,
		});
	}

	/** Human takeover: a non-bot author, or a human closed/merged the PR. */
	#flagTakeover(tick: TickState, snapshot: GithubPullRequestSnapshot): void {
		if (snapshot.authorLogin !== tick.target.botLogin) {
			this.#addAttention(tick, "human_takeover", `author:${snapshot.authorLogin}`, {
				prNumber: snapshot.number,
				authorLogin: snapshot.authorLogin,
			});
		}
		if (snapshot.mergedAt !== null) {
			this.#addAttention(tick, "human_takeover", `${snapshot.nodeId}:merged`, {
				prNumber: snapshot.number,
				state: "merged",
			});
		} else if (snapshot.state === "closed") {
			this.#addAttention(tick, "human_takeover", `${snapshot.nodeId}:closed`, {
				prNumber: snapshot.number,
				state: "closed",
			});
		}
	}

	/** Submitted reviews — including requested changes — as durable events. */
	async #reconcileReviews(tick: TickState, snapshot: GithubPullRequestSnapshot): Promise<void> {
		const key = `reviews|${tick.repository}|${snapshot.number}`;
		const cursor = this.#store.cursors.get<ValidatorsCursor>(key);
		try {
			const page = await this.#client.listReviews(
				tick.target.upstreamOwner,
				tick.target.upstreamRepo,
				snapshot.number,
				validatorsOf(cursor),
			);
			if (page.notModified) return;
			this.#store.cursors.set(key, { etag: page.etag, lastModified: page.lastModified });
			this.#flagTruncation(tick, key, page.truncated);
			for (const review of page.items) {
				const outcome = this.#ingest(tick, "review", review.nodeId, {
					repository: tick.repository,
					eventKind: "review",
					nodeId: review.nodeId,
					prNumber: snapshot.number,
					authorLogin: review.authorLogin,
					authorAssociation: review.authorAssociation,
					state: review.state,
					body: review.body,
					submittedAt: review.submittedAt,
					commitId: review.commitId,
					htmlUrl: review.htmlUrl,
				});
				if (outcome === "duplicate") continue;
				this.#reviewAttention(tick, review);
				tick.lastActivityMs = Math.max(tick.lastActivityMs, Date.parse(review.submittedAt ?? "") || 0);
			}
		} catch (error) {
			this.#ambiguity(tick, key, describeError(error));
		}
	}

	#reviewAttention(tick: TickState, review: GithubReviewSnapshot): void {
		if (review.authorLogin === tick.target.botLogin) return;
		if (review.state === "CHANGES_REQUESTED") {
			this.#addAttention(tick, "review_changes_requested", review.nodeId, {
				prNumber: tick.target.prNumber,
				authorLogin: review.authorLogin,
			});
			return;
		}
		if (review.body.length > 0 && isMaintainer(review.authorAssociation)) {
			this.#addAttention(tick, "maintainer_comment", review.nodeId, {
				prNumber: tick.target.prNumber,
				authorLogin: review.authorLogin,
				source: "review",
			});
		}
	}

	/** Actionable maintainer comment: untrusted body, trusted association. */
	#commentAttention(
		tick: TickState,
		comment: GithubIssueCommentSnapshot | GithubReviewCommentSnapshot,
		source: "issue_comment" | "review_comment",
	): void {
		if (comment.authorLogin === tick.target.botLogin) return;
		if (!isMaintainer(comment.authorAssociation)) return;
		this.#addAttention(tick, "maintainer_comment", comment.nodeId, {
			prNumber: tick.target.prNumber,
			authorLogin: comment.authorLogin,
			source,
		});
	}

	/** Issue comments (conversation-level) as durable events. */
	async #reconcileIssueComments(tick: TickState): Promise<void> {
		const key = `issue-comments|${tick.repository}|${tick.target.prNumber}`;
		const cursor = this.#store.cursors.get<ValidatorsCursor>(key);
		try {
			const page = await this.#client.listIssueComments(
				tick.target.upstreamOwner,
				tick.target.upstreamRepo,
				tick.target.prNumber,
				validatorsOf(cursor),
			);
			if (page.notModified) return;
			this.#store.cursors.set(key, { etag: page.etag, lastModified: page.lastModified });
			this.#flagTruncation(tick, key, page.truncated);
			for (const comment of page.items) {
				const outcome = this.#ingest(tick, "issue_comment", comment.nodeId, {
					repository: tick.repository,
					eventKind: "issue_comment",
					nodeId: comment.nodeId,
					prNumber: tick.target.prNumber,
					authorLogin: comment.authorLogin,
					authorAssociation: comment.authorAssociation,
					body: comment.body,
					createdAt: comment.createdAt,
					updatedAt: comment.updatedAt,
					htmlUrl: comment.htmlUrl,
				});
				if (outcome === "duplicate") continue;
				this.#commentAttention(tick, comment, "issue_comment");
				tick.lastActivityMs = Math.max(tick.lastActivityMs, Date.parse(comment.updatedAt) || 0);
			}
		} catch (error) {
			this.#ambiguity(tick, key, describeError(error));
		}
	}

	/** Code review comments as durable events. */
	async #reconcileReviewComments(
		tick: TickState,
		snapshot: GithubPullRequestSnapshot,
	): Promise<void> {
		const key = `review-comments|${tick.repository}|${snapshot.number}`;
		const cursor = this.#store.cursors.get<ValidatorsCursor>(key);
		try {
			const page = await this.#client.listReviewComments(
				tick.target.upstreamOwner,
				tick.target.upstreamRepo,
				snapshot.number,
				validatorsOf(cursor),
			);
			if (page.notModified) return;
			this.#store.cursors.set(key, { etag: page.etag, lastModified: page.lastModified });
			this.#flagTruncation(tick, key, page.truncated);
			for (const comment of page.items) {
				const outcome = this.#ingest(tick, "review_comment", comment.nodeId, {
					repository: tick.repository,
					eventKind: "review_comment",
					nodeId: comment.nodeId,
					prNumber: snapshot.number,
					authorLogin: comment.authorLogin,
					authorAssociation: comment.authorAssociation,
					body: comment.body,
					createdAt: comment.createdAt,
					updatedAt: comment.updatedAt,
					htmlUrl: comment.htmlUrl,
				});
				if (outcome === "duplicate") continue;
				this.#commentAttention(tick, comment, "review_comment");
				tick.lastActivityMs = Math.max(tick.lastActivityMs, Date.parse(comment.updatedAt) || 0);
			}
		} catch (error) {
			this.#ambiguity(tick, key, describeError(error));
		}
	}

	/** Check runs and the combined status rollup for the PR's head commit. */
	async #reconcileChecks(tick: TickState, snapshot: GithubPullRequestSnapshot): Promise<void> {
		await this.#reconcileCheckRuns(tick, snapshot);
		await this.#reconcileCombinedStatus(tick, snapshot);
	}

	async #reconcileCheckRuns(tick: TickState, snapshot: GithubPullRequestSnapshot): Promise<void> {
		const key = `check-runs|${tick.repository}|${snapshot.headSha}`;
		const cursor = this.#store.cursors.get<ValidatorsCursor>(key);
		try {
			const result = await this.#client.listCheckRunsForRef(
				tick.target.upstreamOwner,
				tick.target.upstreamRepo,
				snapshot.headSha,
				validatorsOf(cursor),
			);
			if (result.notModified) return;
			this.#store.cursors.set(key, { etag: result.etag, lastModified: result.lastModified });
			for (const run of result.data ?? []) {
				const outcome = this.#ingest(tick, "check_run", run.nodeId, {
					repository: tick.repository,
					eventKind: "check_run",
					nodeId: run.nodeId,
					prNumber: snapshot.number,
					headSha: snapshot.headSha,
					name: run.name,
					status: run.status,
					conclusion: run.conclusion,
					startedAt: run.startedAt,
					completedAt: run.completedAt,
					htmlUrl: run.htmlUrl,
				});
				if (outcome === "duplicate") continue;
				if (run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion)) {
					this.#addAttention(tick, "failing_checks", run.nodeId, {
						prNumber: snapshot.number,
						checkName: run.name,
						conclusion: run.conclusion,
					});
				}
			}
		} catch (error) {
			this.#ambiguity(tick, key, describeError(error));
		}
	}

	async #reconcileCombinedStatus(
		tick: TickState,
		snapshot: GithubPullRequestSnapshot,
	): Promise<void> {
		const key = `status|${tick.repository}|${snapshot.headSha}`;
		const cursor = this.#store.cursors.get<ValidatorsCursor>(key);
		try {
			const result = await this.#client.getCombinedStatus(
				tick.target.upstreamOwner,
				tick.target.upstreamRepo,
				snapshot.headSha,
				validatorsOf(cursor),
			);
			if (result.notModified) return;
			this.#store.cursors.set(key, { etag: result.etag, lastModified: result.lastModified });
			const status = result.data;
			if (status === undefined) return;
			// The rollup carries no node id, so the head sha is the stable key.
			this.#ingest(tick, "commit_status", `status-${status.sha}`, {
				repository: tick.repository,
				eventKind: "commit_status",
				nodeId: `status-${status.sha}`,
				prNumber: snapshot.number,
				headSha: status.sha,
				state: status.state,
				totalCount: status.totalCount,
				contexts: status.contexts,
			});
			for (const context of status.contexts) {
				if (context.state === "failure" || context.state === "error") {
					this.#addAttention(tick, "failing_checks", `status:${status.sha}:${context.context}`, {
						prNumber: snapshot.number,
						checkName: context.context,
						state: context.state,
					});
				}
			}
		} catch (error) {
			this.#ambiguity(tick, key, describeError(error));
		}
	}

	/** Flag the PR when upstream went quiet longer than the stale bound. */
	#deriveStaleness(tick: TickState, snapshot: GithubPullRequestSnapshot): void {
		const bound = tick.target.staleAfterMs ?? 0;
		if (bound <= 0 || snapshot.state !== "open" || snapshot.mergedAt !== null) return;
		const cursor = this.#store.cursors.get<PrCursor>(`pr|${tick.repository}|${snapshot.number}`);
		const lastActivityMs = Math.max(
			tick.lastActivityMs,
			cursor?.lastActivityMs ?? 0,
			Date.parse(snapshot.updatedAt) || 0,
		);
		if (this.#clock.nowMs() - lastActivityMs >= bound) {
			this.#addAttention(tick, "stale_author_action", snapshot.nodeId, {
				prNumber: snapshot.number,
				lastActivityMs,
				staleAfterMs: bound,
			});
		}
	}

	// --- shared helpers -------------------------------------------------

	/**
	 * Ingest one normalized fact, keyed by repository + event kind + node id.
	 * Returns "new" (stored), "duplicate" (identical payload already stored),
	 * or "edited" (same node id, changed content — payload replaced).
	 */
	#ingest(
		tick: TickState,
		eventKind: string,
		nodeId: string,
		payload: Record<string, unknown>,
	): "new" | "duplicate" | "edited" {
		const key = `${tick.repository}|${eventKind}|${nodeId}`;
		const payloadJson = canonicalJson(payload);
		const prior = this.#store.events.getGithubEvent(key);
		if (prior === null) {
			this.#store.events.recordGithubEvent({
				nodeId: key,
				campaignId: tick.target.campaignId,
				eventKind,
				payloadJson,
			});
			tick.newEvents += 1;
			return "new";
		}
		if (prior.payloadJson === payloadJson) {
			tick.duplicateEvents += 1;
			return "duplicate";
		}
		this.#store.events.updateGithubEventPayload(key, payloadJson);
		tick.editedEvents += 1;
		return "edited";
	}

	/** Add one attention item unless the same reason+key is already open. */
	#addAttention(
		tick: TickState,
		reason: ReconcileAttentionReason,
		dedupeKey: string,
		detail: Record<string, unknown>,
	): AttentionItemRow | null {
		for (const open of this.#store.events.listOpenAttention(tick.target.campaignId)) {
			if (open.reason === reason && dedupeKeyOf(open) === dedupeKey) {
				return null;
			}
		}
		const item = this.#store.events.addAttention({
			campaignId: tick.target.campaignId,
			workItemId: tick.target.workItemId ?? null,
			reason,
			detailJson: canonicalJson({ dedupeKey, ...detail }),
		});
		tick.attentionAdded.push(item);
		return item;
	}

	#ambiguity(tick: TickState, resource: string, message: string): void {
		this.#addAttention(tick, "unresolved_ambiguity", `resource:${resource}`, {
			resource,
			message,
		});
	}

	#flagTruncation(tick: TickState, resource: string, truncated: boolean): void {
		if (truncated) {
			this.#ambiguity(tick, resource, "pagination bound reached before the collection ended");
		}
	}
}

// Internal mutable tick state, threaded through the helpers above.
interface TickState {
	target: ReconcileTarget;
	repository: string;
	newEvents: number;
	duplicateEvents: number;
	editedEvents: number;
	attentionAdded: AttentionItemRow[];
	wakeUps: number;
	prMissing: boolean;
	lastActivityMs: number;
}

function validatorsOf(cursor: { etag?: string | null; lastModified?: string | null } | null):
	GithubConditionalHeaders | undefined {
	if (cursor === null) return undefined;
	const headers: GithubConditionalHeaders = {};
	if (cursor.etag) headers.etag = cursor.etag;
	if (cursor.lastModified) headers.lastModified = cursor.lastModified;
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function isMaintainer(association: string | null): boolean {
	return association !== null && MAINTAINER_ASSOCIATIONS.has(association);
}

function dedupeKeyOf(item: AttentionItemRow): string | null {
	if (item.detailJson === null) return null;
	try {
		const parsed: unknown = JSON.parse(item.detailJson);
		if (parsed !== null && typeof parsed === "object" && "dedupeKey" in parsed) {
			const key = (parsed as { dedupeKey: unknown }).dedupeKey;
			return typeof key === "string" ? key : null;
		}
	} catch {
		// Malformed detail is treated as no dedupe key.
	}
	return null;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}
