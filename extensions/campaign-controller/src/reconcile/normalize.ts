/**
 * Normalization from narrowed GitHub snapshots to durable source events
 * (warren-323d).
 *
 * Every normalized event carries the repository and PR number alongside
 * the narrowed snapshot fields, and its dedupe identity is
 * repository + event kind + node id. `payloadJson` is canonical (key-sorted)
 * JSON and `payloadDigest` its sha256, so an upstream edit is detectable by
 * digest comparison without ever trusting raw payload bytes. Comment and
 * review bodies flow through as untrusted *data* — nothing here parses or
 * acts on their text (plan pl-91b6 risk 5).
 */

import { canonicalJson, digestOf } from "../digest.ts";
import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubIssueCommentSnapshot,
	GithubNotificationSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";
import type { UpstreamEventKind } from "./types.ts";

/** One normalized source fact, ready for durable ingestion. */
export interface NormalizedSourceEvent {
	readonly kind: UpstreamEventKind;
	/** Durable dedupe node id (synthetic for `_edit`/`_deleted` derivations). */
	readonly nodeId: string;
	/** `owner/repo` of the repository the fact was read from. */
	readonly repository: string;
	readonly payload: Record<string, unknown>;
	readonly payloadJson: string;
	readonly payloadDigest: string;
}

function event(
	kind: UpstreamEventKind,
	nodeId: string,
	repository: string,
	payload: Record<string, unknown>,
): NormalizedSourceEvent {
	const payloadJson = canonicalJson(payload);
	return { kind, nodeId, repository, payload, payloadJson, payloadDigest: digestOf(payloadJson) };
}

/** The `_edit` successor of an already-ingested fact whose digest changed. */
export function editEventOf(base: NormalizedSourceEvent): NormalizedSourceEvent {
	const edit = event(
		`${base.kind}_edit` as UpstreamEventKind,
		`${base.nodeId}#edit#${base.payloadDigest}`,
		base.repository,
		{ ...base.payload, editsNodeId: base.nodeId },
	);
	// The edit row carries the edited fact's digest (not the digest of its
	// own wrapper payload) so a re-poll of the same edited content dedupes
	// against it in the reconciler's latest-digest map.
	return { ...edit, payloadDigest: base.payloadDigest };
}

/** The `_deleted` tombstone for a previously-seen node id now absent. */
export function deletedEventOf(
	kind: UpstreamEventKind,
	nodeId: string,
	repository: string,
	prNumber: number,
): NormalizedSourceEvent {
	return event(`${kind}_deleted` as UpstreamEventKind, `deleted:${nodeId}`, repository, {
		prNumber,
		deletedNodeId: nodeId,
		deletedKind: kind,
	});
}

/** Tombstone-like fact for a PR identity whose authoritative read 404s. */
export function prInaccessibleEvent(repository: string, prNumber: number): NormalizedSourceEvent {
	return event("pr_inaccessible", `pr:${repository}#${String(prNumber)}`, repository, {
		prNumber,
		accessible: false,
	});
}

export function prStateEvent(
	repository: string,
	pr: GithubPullRequestSnapshot,
): NormalizedSourceEvent {
	return event("pr_state", pr.nodeId, repository, {
		prNumber: pr.number,
		state: pr.state,
		draft: pr.draft,
		authorLogin: pr.authorLogin,
		headRef: pr.headRef,
		headSha: pr.headSha,
		headRepoFullName: pr.headRepoFullName,
		baseRef: pr.baseRef,
		baseSha: pr.baseSha,
		baseRepoFullName: pr.baseRepoFullName,
		mergedAt: pr.mergedAt,
		closedAt: pr.closedAt,
		updatedAt: pr.updatedAt,
		htmlUrl: pr.htmlUrl,
	});
}

export function issueCommentEvent(
	repository: string,
	prNumber: number,
	comment: GithubIssueCommentSnapshot,
): NormalizedSourceEvent {
	return event("issue_comment", comment.nodeId, repository, {
		prNumber,
		id: comment.id,
		authorLogin: comment.authorLogin,
		authorAssociation: comment.authorAssociation,
		body: comment.body,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
		htmlUrl: comment.htmlUrl,
	});
}

export function reviewEvent(
	repository: string,
	prNumber: number,
	review: GithubReviewSnapshot,
): NormalizedSourceEvent {
	return event("review", review.nodeId, repository, {
		prNumber,
		id: review.id,
		authorLogin: review.authorLogin,
		authorAssociation: review.authorAssociation,
		state: review.state,
		body: review.body,
		submittedAt: review.submittedAt,
		commitId: review.commitId,
		htmlUrl: review.htmlUrl,
	});
}

export function reviewCommentEvent(
	repository: string,
	prNumber: number,
	comment: GithubReviewCommentSnapshot,
): NormalizedSourceEvent {
	return event("review_comment", comment.nodeId, repository, {
		prNumber,
		id: comment.id,
		authorLogin: comment.authorLogin,
		authorAssociation: comment.authorAssociation,
		body: comment.body,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
		htmlUrl: comment.htmlUrl,
	});
}

export function checkRunEvent(
	repository: string,
	prNumber: number,
	headSha: string,
	check: GithubCheckRunSnapshot,
): NormalizedSourceEvent {
	return event("check_run", check.nodeId, repository, {
		prNumber,
		headSha,
		name: check.name,
		status: check.status,
		conclusion: check.conclusion,
		startedAt: check.startedAt,
		completedAt: check.completedAt,
		htmlUrl: check.htmlUrl,
	});
}

/** Combined status has no node id upstream; the sha-scoped synthetic id is stable. */
export function combinedStatusEvent(
	repository: string,
	prNumber: number,
	status: GithubCombinedStatusSnapshot,
): NormalizedSourceEvent {
	return event("combined_status", `combined-status:${repository}@${status.sha}`, repository, {
		prNumber,
		sha: status.sha,
		state: status.state,
		totalCount: status.totalCount,
		contexts: status.contexts,
	});
}

/** The pinned repository-policy content read (CONTRIBUTING and friends). */
export function policyContentEvent(
	repository: string,
	path: string,
	textDigest: string,
): NormalizedSourceEvent {
	return event("policy_content", `policy:${repository}:${path}`, repository, {
		path,
		textDigest,
	});
}

/** A participating notification, stored as a wake-up fact and nothing more. */
export function notificationEvent(notification: GithubNotificationSnapshot): NormalizedSourceEvent {
	return event("notification", notification.nodeId, notification.repositoryFullName, {
		reason: notification.reason,
		updatedAt: notification.updatedAt,
		subjectType: notification.subjectType,
		subjectTitle: notification.subjectTitle,
		subjectUrl: notification.subjectUrl,
	});
}
