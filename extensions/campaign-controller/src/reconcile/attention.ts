/**
 * Attention derivation for read-only upstream PR reconciliation
 * (warren-323d, design record §10.1).
 *
 * Pure functions: the reconciled authoritative state of one PR in, the
 * complete set of attention categories out. Every derivation is
 * deterministic and stable — the same upstream state always derives the
 * same `{reason, subjectKey}` pairs, which is what lets the reconciler
 * dedupe attention durably across polls and restarts.
 *
 * Nothing here interprets comment or review text. Bodies are untrusted
 * data; a maintainer comment raises `maintainer_comment` based on author
 * association alone, never on what the text says, and no derivation ever
 * produces a controller command.
 */

import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";
import {
	type AttentionReason,
	FAILING_CHECK_CONCLUSIONS,
	FAILING_COMBINED_STATES,
	KNOWN_CHECK_CONCLUSIONS,
	KNOWN_CHECK_STATUSES,
	KNOWN_PR_STATES,
	KNOWN_REVIEW_STATES,
	MAINTAINER_ASSOCIATIONS,
} from "./types.ts";

/** One derived attention item, before durable dedupe. */
export interface DerivedAttention {
	readonly reason: AttentionReason;
	/** Stable identity of the upstream subject (node id, path, or `pr`). */
	readonly subjectKey: string;
	readonly detail: Record<string, unknown>;
}

export interface AttentionDerivationInput {
	readonly pr: GithubPullRequestSnapshot;
	readonly botLogin: string;
	/** Head sha the controller last explained from its own dispatched work. */
	readonly expectedHeadSha?: string | null;
	/** Non-null when the pinned policy content digest no longer matches. */
	readonly policyChange?: {
		path: string;
		expectedSha256: string;
		actualSha256: string | null;
	} | null;
	readonly issueComments: readonly GithubIssueCommentSnapshot[];
	readonly reviewComments: readonly GithubReviewCommentSnapshot[];
	readonly reviews: readonly GithubReviewSnapshot[];
	readonly checkRuns: readonly GithubCheckRunSnapshot[];
	readonly combinedStatus: GithubCombinedStatusSnapshot | null;
	/** Node ids previously observed that vanished upstream (deletions). */
	readonly deletedNodeIds: readonly string[];
	/** Collection kinds whose paginated read hit the page bound. */
	readonly truncatedKinds: readonly string[];
	readonly nowMs: number;
	/** Age after which unanswered human feedback becomes stale. */
	readonly staleAfterMs: number;
}

interface MaintainerComment {
	readonly nodeId: string;
	readonly authorLogin: string;
	readonly createdAt: string;
	readonly source: "issue_comment" | "review_comment";
}

function isMaintainer(association: string): boolean {
	return MAINTAINER_ASSOCIATIONS.includes(association);
}

function epochMs(iso: string | null): number | null {
	if (iso === null) return null;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : null;
}

function item(
	reason: AttentionReason,
	subjectKey: string,
	detail: Record<string, unknown>,
): DerivedAttention {
	return { reason, subjectKey, detail };
}

/** Each non-bot reviewer's latest submitted (non-pending) review. */
export function latestReviewsByAuthor(input: AttentionDerivationInput): GithubReviewSnapshot[] {
	const latest = new Map<string, { review: GithubReviewSnapshot; ts: number }>();
	for (const review of input.reviews) {
		if (review.authorLogin === input.botLogin || review.state === "PENDING") continue;
		const ts = epochMs(review.submittedAt) ?? 0;
		const prior = latest.get(review.authorLogin);
		if (prior === undefined || ts >= prior.ts) {
			latest.set(review.authorLogin, { review, ts });
		}
	}
	return [...latest.values()].map((entry) => entry.review);
}

/** Comments from upstream maintainers (association-based, never text-based). */
function maintainerCommentsOf(input: AttentionDerivationInput): MaintainerComment[] {
	const out: MaintainerComment[] = [];
	const collect = (
		comments: ReadonlyArray<{
			nodeId: string;
			authorLogin: string;
			authorAssociation: string;
			createdAt: string;
		}>,
		source: MaintainerComment["source"],
	) => {
		for (const comment of comments) {
			if (comment.authorLogin !== input.botLogin && isMaintainer(comment.authorAssociation)) {
				out.push({
					nodeId: comment.nodeId,
					authorLogin: comment.authorLogin,
					createdAt: comment.createdAt,
					source,
				});
			}
		}
	};
	collect(input.issueComments, "issue_comment");
	collect(input.reviewComments, "review_comment");
	return out;
}

function deriveTakeover(input: AttentionDerivationInput): DerivedAttention[] {
	const out: DerivedAttention[] = [];
	if (input.pr.authorLogin !== input.botLogin) {
		out.push(
			item("human_takeover", "pr", {
				prNumber: input.pr.number,
				authorLogin: input.pr.authorLogin,
				botLogin: input.botLogin,
			}),
		);
	}
	const expected = input.expectedHeadSha;
	if (expected !== undefined && expected !== null && expected !== input.pr.headSha) {
		out.push(
			item("human_takeover", `head:${input.pr.headSha}`, {
				prNumber: input.pr.number,
				expectedHeadSha: expected,
				actualHeadSha: input.pr.headSha,
			}),
		);
	}
	return out;
}

function checkAmbiguity(check: GithubCheckRunSnapshot): DerivedAttention[] {
	const out: DerivedAttention[] = [];
	if (!KNOWN_CHECK_STATUSES.includes(check.status)) {
		out.push(
			item("unresolved_ambiguity", `check-status:${check.nodeId}`, {
				checkNodeId: check.nodeId,
				status: check.status,
			}),
		);
	}
	if (
		check.status === "completed" &&
		(check.conclusion === null || !KNOWN_CHECK_CONCLUSIONS.includes(check.conclusion))
	) {
		out.push(
			item("unresolved_ambiguity", `check-conclusion:${check.nodeId}`, {
				checkNodeId: check.nodeId,
				conclusion: check.conclusion,
			}),
		);
	}
	return out;
}

function deriveAmbiguity(input: AttentionDerivationInput): DerivedAttention[] {
	const out: DerivedAttention[] = [];
	if (!KNOWN_PR_STATES.includes(input.pr.state)) {
		out.push(
			item("unresolved_ambiguity", `pr-state:${input.pr.state}`, {
				prNumber: input.pr.number,
				state: input.pr.state,
			}),
		);
	}
	for (const review of input.reviews) {
		if (!KNOWN_REVIEW_STATES.includes(review.state)) {
			out.push(
				item("unresolved_ambiguity", `review-state:${review.nodeId}`, {
					reviewNodeId: review.nodeId,
					state: review.state,
				}),
			);
		}
	}
	for (const check of input.checkRuns) {
		out.push(...checkAmbiguity(check));
	}
	for (const nodeId of input.deletedNodeIds) {
		out.push(item("unresolved_ambiguity", `deleted:${nodeId}`, { deletedNodeId: nodeId }));
	}
	for (const kind of input.truncatedKinds) {
		out.push(item("unresolved_ambiguity", `truncated:${kind}`, { kind }));
	}
	return out;
}

function deriveRequestedChanges(input: AttentionDerivationInput): DerivedAttention[] {
	const out: DerivedAttention[] = [];
	for (const review of latestReviewsByAuthor(input)) {
		if (review.state === "CHANGES_REQUESTED") {
			out.push(
				item("requested_changes", review.nodeId, {
					reviewNodeId: review.nodeId,
					authorLogin: review.authorLogin,
					submittedAt: review.submittedAt,
				}),
			);
		}
	}
	return out;
}

function deriveFailingChecks(input: AttentionDerivationInput): DerivedAttention[] {
	const failing = input.checkRuns.filter(
		(check) =>
			check.status === "completed" &&
			check.conclusion !== null &&
			FAILING_CHECK_CONCLUSIONS.includes(check.conclusion),
	);
	if (failing.length > 0) {
		return failing.map((check) =>
			item("failing_checks", check.nodeId, {
				checkNodeId: check.nodeId,
				name: check.name,
				conclusion: check.conclusion,
			}),
		);
	}
	const status = input.combinedStatus;
	if (status !== null && FAILING_COMBINED_STATES.includes(status.state)) {
		return [
			item("failing_checks", `combined-status:${status.sha}`, {
				sha: status.sha,
				state: status.state,
			}),
		];
	}
	return [];
}

function latestHumanFeedbackMs(input: AttentionDerivationInput): number | null {
	const timestamps: number[] = [];
	for (const review of latestReviewsByAuthor(input)) {
		if (review.state === "CHANGES_REQUESTED") {
			const ts = epochMs(review.submittedAt);
			if (ts !== null) timestamps.push(ts);
		}
	}
	for (const comment of maintainerCommentsOf(input)) {
		const ts = epochMs(comment.createdAt);
		if (ts !== null) timestamps.push(ts);
	}
	return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function latestBotActivityMs(input: AttentionDerivationInput): number | null {
	const timestamps: number[] = [];
	for (const comment of input.issueComments) {
		if (comment.authorLogin === input.botLogin) {
			const ts = epochMs(comment.createdAt);
			if (ts !== null) timestamps.push(ts);
		}
	}
	for (const review of input.reviews) {
		if (review.authorLogin === input.botLogin) {
			const ts = epochMs(review.submittedAt);
			if (ts !== null) timestamps.push(ts);
		}
	}
	return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function deriveStale(input: AttentionDerivationInput): DerivedAttention[] {
	const latestHuman = latestHumanFeedbackMs(input);
	if (latestHuman === null || input.nowMs - latestHuman <= input.staleAfterMs) {
		return [];
	}
	const latestBot = latestBotActivityMs(input);
	if (latestBot !== null && latestBot >= latestHuman) {
		return [];
	}
	return [
		item("stale_author_action", "pr", {
			prNumber: input.pr.number,
			latestHumanActivityAt: new Date(latestHuman).toISOString(),
			latestBotActivityAt: latestBot === null ? null : new Date(latestBot).toISOString(),
		}),
	];
}

/** Derive every attention category for one reconciled PR. */
export function deriveAttention(input: AttentionDerivationInput): DerivedAttention[] {
	const policy = input.policyChange;
	return [
		...deriveTakeover(input),
		...deriveAmbiguity(input),
		...deriveRequestedChanges(input),
		...maintainerCommentsOf(input).map((comment) =>
			item("maintainer_comment", comment.nodeId, { ...comment }),
		),
		...deriveFailingChecks(input),
		...(policy !== undefined && policy !== null
			? [item("policy_change", policy.path, policy)]
			: []),
		...deriveStale(input),
	];
}
