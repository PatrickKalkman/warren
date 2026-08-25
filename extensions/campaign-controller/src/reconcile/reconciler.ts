/**
 * Read-only upstream PR reconciliation (warren-323d, plan pl-91b6 step 9,
 * design record §10.1).
 *
 * The reconciler treats participating notifications purely as wake-ups and
 * reconciles authoritative PR, review, issue-comment, review-comment, and
 * check state through GET/HEAD reads only. Every observed fact is
 * normalized and durably deduplicated by repository + event kind + node id,
 * so reordered pages, at-least-once delivery, and restart replays converge
 * to the same store. Edits append `_edit` facts, deletions append
 * `_deleted` tombstones, and a 404 on the PR itself becomes an explicit
 * `pr_inaccessible` fact — history is never erased.
 *
 * This module has no mutation capability by construction: it only holds a
 * `ReadOnlyGithubClient`, whose transport fails hard on any non-GET/HEAD
 * method. It never dispatches repairs, replies, resolves threads,
 * rerequests review, or interprets comment text as commands.
 */

import type { Clock } from "../clock.ts";
import { canonicalJson, digestOf } from "../digest.ts";
import type { ReadOnlyGithubClient } from "../github/client.ts";
import { GithubApiError } from "../github/errors.ts";
import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { AttentionItemRow } from "../store/types.ts";
import { deriveAttention } from "./attention.ts";
import {
	checkRunEvent,
	combinedStatusEvent,
	deletedEventOf,
	editEventOf,
	issueCommentEvent,
	type NormalizedSourceEvent,
	notificationEvent,
	policyContentEvent,
	prInaccessibleEvent,
	prStateEvent,
	reviewCommentEvent,
	reviewEvent,
} from "./normalize.ts";
import type { DeletableEventKind } from "./types.ts";

const DEFAULT_STALE_AFTER_MS = 72 * 60 * 60 * 1000;

export interface UpstreamReconcilerDeps {
	readonly client: ReadOnlyGithubClient;
	readonly store: CampaignStateStore;
	readonly clock: Clock;
}

export interface ReconcilePullRequestInput {
	readonly campaignId: string;
	readonly workItemId?: string | null;
	/** Upstream repository owner of the already-known PR identity. */
	readonly owner: string;
	/** Upstream repository name of the already-known PR identity. */
	readonly repo: string;
	/** Upstream PR number of the already-known PR identity. */
	readonly pullNumber: number;
	/** Login of the bot account the controller operates as. */
	readonly botLogin: string;
	/** Head sha the controller last explained from its own dispatched work. */
	readonly expectedHeadSha?: string | null;
	/** Pinned repository-policy content expectation (CONTRIBUTING digest). */
	readonly expectedPolicy?: { path: string; contentSha256: string } | null;
	/** Age after which unanswered human feedback goes stale (default 72h). */
	readonly staleAfterMs?: number;
}

export interface ReconcilePullRequestResult {
	readonly status: "reconciled" | "pr_inaccessible";
	readonly newEvents: number;
	readonly editedEvents: number;
	readonly duplicateEvents: number;
	readonly attentionAdded: readonly AttentionItemRow[];
	readonly attentionSkipped: number;
	readonly headSha: string | null;
}

/** A participating notification reduced to a reconcile target (wake-up only). */
export interface NotificationWakeUp {
	readonly repositoryFullName: string;
	readonly pullNumber: number | null;
	readonly reason: string;
}

interface IngestCounters {
	newEvents: number;
	editedEvents: number;
	duplicateEvents: number;
}

interface PrCollections {
	readonly issueComments: readonly GithubIssueCommentSnapshot[];
	readonly reviews: readonly GithubReviewSnapshot[];
	readonly reviewComments: readonly GithubReviewCommentSnapshot[];
	readonly checkRuns: readonly GithubCheckRunSnapshot[];
	readonly combinedStatus: GithubCombinedStatusSnapshot | null;
	readonly truncatedKinds: readonly string[];
}

type PrRead = { kind: "ok"; pr: GithubPullRequestSnapshot } | { kind: "inaccessible" };

export class UpstreamPrReconciler {
	readonly #client: ReadOnlyGithubClient;
	readonly #store: CampaignStateStore;
	readonly #clock: Clock;

	constructor(deps: UpstreamReconcilerDeps) {
		this.#client = deps.client;
		this.#store = deps.store;
		this.#clock = deps.clock;
	}

	/**
	 * List participating notifications as wake-ups. Each notification is
	 * durably deduped as a `notification` fact; the returned refs are the
	 * PRs worth reconciling. Notification payloads are never treated as
	 * truth or commands — reconciliation re-reads everything (plan risk 3).
	 */
	async collectNotificationWakeUps(campaignId: string): Promise<NotificationWakeUp[]> {
		const page = await this.#client.listNotifications({ participating: true });
		const latest = this.latestDigestByNode(campaignId);
		const counters: IngestCounters = { newEvents: 0, editedEvents: 0, duplicateEvents: 0 };
		const wakeUps = new Map<string, NotificationWakeUp>();
		for (const notification of page.items) {
			this.ingest(campaignId, latest, notificationEvent(notification), counters);
			const pullNumber = parsePullSubjectUrl(notification.subjectUrl);
			const key = `${notification.repositoryFullName}#${String(pullNumber)}`;
			if (!wakeUps.has(key)) {
				wakeUps.set(key, {
					repositoryFullName: notification.repositoryFullName,
					pullNumber,
					reason: notification.reason,
				});
			}
		}
		return [...wakeUps.values()];
	}

	/** Reconcile one already-known upstream PR identity, read-only. */
	async reconcilePullRequest(
		input: ReconcilePullRequestInput,
	): Promise<ReconcilePullRequestResult> {
		const repository = `${input.owner}/${input.repo}`;
		const latest = this.latestDigestByNode(input.campaignId);
		const counters: IngestCounters = { newEvents: 0, editedEvents: 0, duplicateEvents: 0 };
		const cursorScope = `pr-reconcile:${repository}#${String(input.pullNumber)}`;

		const read = await this.readPr(input, repository);
		if (read.kind === "inaccessible") {
			this.ingest(
				input.campaignId,
				latest,
				prInaccessibleEvent(repository, input.pullNumber),
				counters,
			);
			const attention = this.commitAttention(input, [
				{
					reason: "unresolved_ambiguity",
					subjectKey: `pr-inaccessible:${repository}#${String(input.pullNumber)}`,
					detail: { prNumber: input.pullNumber, repository },
				},
			]);
			this.saveCursor(cursorScope, repository, input.pullNumber, null, "pr_inaccessible");
			return this.result("pr_inaccessible", counters, attention, null);
		}

		const pr = read.pr;
		this.ingest(input.campaignId, latest, prStateEvent(repository, pr), counters);
		const collections = await this.readCollections(input, pr);
		this.ingestCollections(input, repository, pr, collections, latest, counters);
		const deletedNodeIds = this.detectDeletions(input, repository, collections, latest, counters);
		const policyChange = await this.readPolicyDrift(input, repository, latest, counters);

		const derived = deriveAttention({
			pr,
			botLogin: input.botLogin,
			expectedHeadSha: input.expectedHeadSha ?? null,
			policyChange,
			issueComments: collections.issueComments,
			reviewComments: collections.reviewComments,
			reviews: collections.reviews,
			checkRuns: collections.checkRuns,
			combinedStatus: collections.combinedStatus,
			deletedNodeIds,
			truncatedKinds: collections.truncatedKinds,
			nowMs: this.#clock.nowMs(),
			staleAfterMs: input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
		});
		const attention = this.commitAttention(input, derived);
		this.saveCursor(cursorScope, repository, input.pullNumber, pr.headSha, "reconciled");
		return this.result("reconciled", counters, attention, pr.headSha);
	}

	/** Authoritative PR read; a 404 is an explicit inaccessible marker. */
	private async readPr(input: ReconcilePullRequestInput, repository: string): Promise<PrRead> {
		try {
			const result = await this.#client.getPullRequest(input.owner, input.repo, input.pullNumber);
			if (result.data === undefined) {
				throw new GithubApiError("pull request read returned no data", {
					status: 0,
					path: `/repos/${repository}/pulls/${String(input.pullNumber)}`,
				});
			}
			return { kind: "ok", pr: result.data };
		} catch (error) {
			if (error instanceof GithubApiError && error.status === 404) {
				return { kind: "inaccessible" };
			}
			throw error;
		}
	}

	/** Read every authoritative collection for the PR's current head. */
	private async readCollections(
		input: ReconcilePullRequestInput,
		pr: GithubPullRequestSnapshot,
	): Promise<PrCollections> {
		const issueComments = await this.#client.listIssueComments(
			input.owner,
			input.repo,
			input.pullNumber,
		);
		const reviews = await this.#client.listReviews(input.owner, input.repo, input.pullNumber);
		const reviewComments = await this.#client.listReviewComments(
			input.owner,
			input.repo,
			input.pullNumber,
		);
		const checkRuns = await this.#client.listCheckRunsForRef(input.owner, input.repo, pr.headSha);
		const combinedStatus = await this.#client.getCombinedStatus(
			input.owner,
			input.repo,
			pr.headSha,
		);
		const truncatedKinds: string[] = [];
		if (issueComments.truncated) truncatedKinds.push("issue_comment");
		if (reviews.truncated) truncatedKinds.push("review");
		if (reviewComments.truncated) truncatedKinds.push("review_comment");
		return {
			issueComments: issueComments.items,
			reviews: reviews.items,
			reviewComments: reviewComments.items,
			checkRuns: checkRuns.data ?? [],
			combinedStatus: combinedStatus.data ?? null,
			truncatedKinds,
		};
	}

	/** Ingest every collection snapshot with edit-aware dedupe. */
	private ingestCollections(
		input: ReconcilePullRequestInput,
		repository: string,
		pr: GithubPullRequestSnapshot,
		collections: PrCollections,
		latest: Map<string, string>,
		counters: IngestCounters,
	): void {
		const pullNumber = input.pullNumber;
		for (const comment of collections.issueComments) {
			this.ingest(
				input.campaignId,
				latest,
				issueCommentEvent(repository, pullNumber, comment),
				counters,
			);
		}
		for (const review of collections.reviews) {
			this.ingest(input.campaignId, latest, reviewEvent(repository, pullNumber, review), counters);
		}
		for (const comment of collections.reviewComments) {
			this.ingest(
				input.campaignId,
				latest,
				reviewCommentEvent(repository, pullNumber, comment),
				counters,
			);
		}
		for (const check of collections.checkRuns) {
			this.ingest(
				input.campaignId,
				latest,
				checkRunEvent(repository, pullNumber, pr.headSha, check),
				counters,
			);
		}
		if (collections.combinedStatus !== null) {
			this.ingest(
				input.campaignId,
				latest,
				combinedStatusEvent(repository, pullNumber, collections.combinedStatus),
				counters,
			);
		}
	}

	/**
	 * Tombstone previously-seen node ids absent from the current read.
	 * Skipped for any truncated collection — a partial page cannot prove
	 * absence, and truncation itself surfaces as unresolved ambiguity.
	 */
	private detectDeletions(
		input: ReconcilePullRequestInput,
		repository: string,
		collections: PrCollections,
		latest: Map<string, string>,
		counters: IngestCounters,
	): string[] {
		const observedByKind: Record<DeletableEventKind, ReadonlySet<string>> = {
			issue_comment: new Set(collections.issueComments.map((item) => item.nodeId)),
			review: new Set(collections.reviews.map((item) => item.nodeId)),
			review_comment: new Set(collections.reviewComments.map((item) => item.nodeId)),
		};
		const deletedNodeIds: string[] = [];
		const kinds: DeletableEventKind[] = ["issue_comment", "review", "review_comment"];
		for (const kind of kinds) {
			if (collections.truncatedKinds.includes(kind)) continue;
			const observed = observedByKind[kind];
			for (const nodeId of this.priorNodeIds(
				input.campaignId,
				kind,
				repository,
				input.pullNumber,
			)) {
				if (observed.has(nodeId)) continue;
				deletedNodeIds.push(nodeId);
				this.ingest(
					input.campaignId,
					latest,
					deletedEventOf(kind, nodeId, repository, input.pullNumber),
					counters,
				);
			}
		}
		return deletedNodeIds;
	}

	/** Read the pinned repository-policy content and report digest drift. */
	private async readPolicyDrift(
		input: ReconcilePullRequestInput,
		repository: string,
		latest: Map<string, string>,
		counters: IngestCounters,
	): Promise<{ path: string; expectedSha256: string; actualSha256: string | null } | null> {
		const policy = input.expectedPolicy;
		if (policy === undefined || policy === null) return null;
		let actualSha256: string | null = null;
		try {
			const content = await this.#client.getContent(input.owner, input.repo, policy.path);
			if (content.data !== undefined) {
				actualSha256 = digestOf(content.data.text);
			}
		} catch (error) {
			if (!(error instanceof GithubApiError && error.status === 404)) {
				throw error;
			}
		}
		this.ingest(
			input.campaignId,
			latest,
			policyContentEvent(repository, policy.path, actualSha256 ?? "missing"),
			counters,
		);
		if (actualSha256 === policy.contentSha256) return null;
		return { path: policy.path, expectedSha256: policy.contentSha256, actualSha256 };
	}

	/**
	 * Map of base node id → latest observed payload digest, folded from the
	 * durable event log. `_edit` rows carry the digest of the edited fact so
	 * a re-poll of the same edited content dedupes instead of re-editing.
	 */
	private latestDigestByNode(campaignId: string): Map<string, string> {
		const latest = new Map<string, string>();
		for (const row of this.#store.events.listGithubEvents(campaignId)) {
			const baseNodeId = row.nodeId.split("#edit#")[0] ?? row.nodeId;
			latest.set(baseNodeId, row.payloadDigest);
		}
		return latest;
	}

	/** Previously-ingested node ids of one collection kind for this PR. */
	private priorNodeIds(
		campaignId: string,
		kind: DeletableEventKind,
		repository: string,
		pullNumber: number,
	): string[] {
		const nodeIds: string[] = [];
		for (const row of this.#store.events.listGithubEvents(campaignId, kind)) {
			if (row.repository !== repository) continue;
			const payload = JSON.parse(row.payloadJson) as { prNumber?: unknown };
			if (payload.prNumber === pullNumber) {
				nodeIds.push(row.nodeId);
			}
		}
		return nodeIds;
	}

	/** Ingest one normalized fact with edit-aware durable dedupe. */
	private ingest(
		campaignId: string,
		latest: Map<string, string>,
		event: NormalizedSourceEvent,
		counters: IngestCounters,
	): void {
		const knownDigest = latest.get(event.nodeId);
		if (knownDigest === undefined) {
			if (this.recordEvent(campaignId, event)) {
				latest.set(event.nodeId, event.payloadDigest);
				counters.newEvents += 1;
			} else {
				counters.duplicateEvents += 1;
			}
			return;
		}
		if (knownDigest === event.payloadDigest) {
			counters.duplicateEvents += 1;
			return;
		}
		if (this.recordEvent(campaignId, editEventOf(event))) {
			latest.set(event.nodeId, event.payloadDigest);
			counters.editedEvents += 1;
		} else {
			counters.duplicateEvents += 1;
		}
	}

	private recordEvent(campaignId: string, event: NormalizedSourceEvent): boolean {
		return this.#store.events.recordGithubEvent({
			nodeId: event.nodeId,
			campaignId,
			eventKind: event.kind,
			repository: event.repository,
			payloadJson: event.payloadJson,
			payloadDigest: event.payloadDigest,
		});
	}

	/**
	 * Commit derived attention with durable dedupe: an open item with the
	 * same work item, reason, and subject key already covers the fact, so a
	 * re-poll or restart never doubles the queue.
	 */
	private commitAttention(
		input: ReconcilePullRequestInput,
		derived: ReadonlyArray<{ reason: string; subjectKey: string; detail: Record<string, unknown> }>,
	): { added: AttentionItemRow[]; skipped: number } {
		const workItemId = input.workItemId ?? null;
		const open = this.#store.events.listOpenAttention(input.campaignId);
		const openKeys = new Set(
			open.map((row) => attentionKey(row.workItemId, row.reason, subjectKeyOf(row.detailJson))),
		);
		const added: AttentionItemRow[] = [];
		let skipped = 0;
		for (const item of derived) {
			const key = attentionKey(workItemId, item.reason, item.subjectKey);
			if (openKeys.has(key)) {
				skipped += 1;
				continue;
			}
			openKeys.add(key);
			added.push(
				this.#store.events.addAttention({
					campaignId: input.campaignId,
					workItemId,
					reason: item.reason,
					detailJson: canonicalJson({ subjectKey: item.subjectKey, ...item.detail }),
				}),
			);
		}
		return { added, skipped };
	}

	private saveCursor(
		scope: string,
		repository: string,
		pullNumber: number,
		headSha: string | null,
		outcome: string,
	): void {
		this.#store.cursors.setCursor(
			scope,
			canonicalJson({
				repository,
				pullNumber,
				headSha,
				outcome,
				lastCompletedAtMs: this.#clock.nowMs(),
			}),
		);
	}

	private result(
		status: "reconciled" | "pr_inaccessible",
		counters: IngestCounters,
		attention: { added: AttentionItemRow[]; skipped: number },
		headSha: string | null,
	): ReconcilePullRequestResult {
		return {
			status,
			newEvents: counters.newEvents,
			editedEvents: counters.editedEvents,
			duplicateEvents: counters.duplicateEvents,
			attentionAdded: attention.added,
			attentionSkipped: attention.skipped,
			headSha,
		};
	}
}

function attentionKey(workItemId: string | null, reason: string, subjectKey: string): string {
	return `${workItemId ?? ""}|${reason}|${subjectKey}`;
}

function subjectKeyOf(detailJson: string | null): string {
	if (detailJson === null) return "";
	try {
		const parsed = JSON.parse(detailJson) as { subjectKey?: unknown };
		return typeof parsed.subjectKey === "string" ? parsed.subjectKey : "";
	} catch {
		return "";
	}
}

/** Parse `https://api.github.com/repos/{owner}/{repo}/pulls/{n}` subjects. */
function parsePullSubjectUrl(subjectUrl: string): number | null {
	const match = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(subjectUrl);
	if (match === null || match[1] === undefined) return null;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isFinite(parsed) ? parsed : null;
}
