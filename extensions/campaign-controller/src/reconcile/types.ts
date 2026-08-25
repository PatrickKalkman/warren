/**
 * Vocabulary for read-only upstream PR reconciliation (warren-323d, plan
 * pl-91b6 step 9, design record §10.1).
 *
 * Event kinds name the authoritative GitHub read a fact came from. Edits
 * and deletions are separate kinds so the durable event log stays
 * insert-only — an edit appends a `<kind>_edit` fact keyed off the original
 * node id, and a deletion appends a `<kind>_deleted` tombstone rather than
 * erasing history.
 *
 * Attention reasons are the complete set of categories V0 derives. Every
 * one is a durable human-attention queue entry; none of them ever triggers
 * a GitHub mutation, a repair dispatch, or a reply.
 */

/** Durable upstream source-event kinds. */
export type UpstreamEventKind =
	| "notification"
	| "pr_state"
	| "pr_inaccessible"
	| "issue_comment"
	| "issue_comment_edit"
	| "issue_comment_deleted"
	| "review"
	| "review_edit"
	| "review_deleted"
	| "review_comment"
	| "review_comment_edit"
	| "review_comment_deleted"
	| "check_run"
	| "check_run_edit"
	| "combined_status"
	| "policy_content";

/** The base kinds an upstream edit can produce a `_edit` successor for. */
export type EditableEventKind =
	| "pr_state"
	| "issue_comment"
	| "review"
	| "review_comment"
	| "check_run"
	| "combined_status"
	| "policy_content";

/** The collection kinds a missing node id tombstones as `_deleted`. */
export type DeletableEventKind = "issue_comment" | "review" | "review_comment";

/** Every attention category V0 derives (seed warren-323d acceptance). */
export type AttentionReason =
	| "requested_changes"
	| "maintainer_comment"
	| "failing_checks"
	| "policy_change"
	| "human_takeover"
	| "stale_author_action"
	| "unresolved_ambiguity";

/** GitHub author associations that count as upstream maintainers. */
export const MAINTAINER_ASSOCIATIONS: readonly string[] = ["MEMBER", "OWNER", "COLLABORATOR"];

/** Review states GitHub can return; anything else is ambiguity. */
export const KNOWN_REVIEW_STATES: readonly string[] = [
	"APPROVED",
	"CHANGES_REQUESTED",
	"COMMENTED",
	"DISMISSED",
	"PENDING",
];

/** Check-run statuses GitHub can return; anything else is ambiguity. */
export const KNOWN_CHECK_STATUSES: readonly string[] = ["queued", "in_progress", "completed"];

/** Check-run conclusions GitHub can return; anything else is ambiguity. */
export const KNOWN_CHECK_CONCLUSIONS: readonly string[] = [
	"success",
	"failure",
	"neutral",
	"cancelled",
	"skipped",
	"timed_out",
	"action_required",
	"startup_failure",
	"stale",
];

/** Completed conclusions that mean the PR cannot merge as-is. */
export const FAILING_CHECK_CONCLUSIONS: readonly string[] = [
	"failure",
	"timed_out",
	"action_required",
	"startup_failure",
];

/** Combined-status states that mean failing at the commit level. */
export const FAILING_COMBINED_STATES: readonly string[] = ["failure", "error"];

/** PR states the reconciler understands; anything else is ambiguity. */
export const KNOWN_PR_STATES: readonly string[] = ["open", "closed"];
