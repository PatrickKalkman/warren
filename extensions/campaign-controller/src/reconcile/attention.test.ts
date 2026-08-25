import { describe, expect, test } from "bun:test";
import type {
	GithubCheckRunSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";
import { type AttentionDerivationInput, deriveAttention } from "./attention.ts";
import type { AttentionReason } from "./types.ts";

const NOW = Date.parse("2026-08-25T00:00:00Z");
const BOT = "warren-run-bot";
const STALE_AFTER = 72 * 60 * 60 * 1000;

function pr(overrides: Partial<GithubPullRequestSnapshot> = {}): GithubPullRequestSnapshot {
	return {
		nodeId: "PR_1",
		number: 7,
		state: "open",
		draft: false,
		title: "Fix the thing",
		authorLogin: BOT,
		headRef: "warren/issue-42",
		headSha: "abc123",
		headRepoFullName: `${BOT}/openclaw`,
		baseRef: "main",
		baseSha: "def456",
		baseRepoFullName: "openclaw/openclaw",
		mergedAt: null,
		closedAt: null,
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-02T00:00:00Z",
		htmlUrl: "https://github.com/openclaw/openclaw/pull/7",
		...overrides,
	};
}

function issueComment(
	overrides: Partial<GithubIssueCommentSnapshot> = {},
): GithubIssueCommentSnapshot {
	return {
		nodeId: "IC_1",
		id: 11,
		authorLogin: "maintainer-jane",
		authorAssociation: "MEMBER",
		body: "please add a test",
		createdAt: "2026-08-20T00:00:00Z",
		updatedAt: "2026-08-20T00:00:00Z",
		htmlUrl: "https://github.com/openclaw/openclaw/issues/7#issuecomment-11",
		...overrides,
	};
}

function reviewComment(
	overrides: Partial<GithubReviewCommentSnapshot> = {},
): GithubReviewCommentSnapshot {
	return {
		nodeId: "RC_1",
		id: 21,
		authorLogin: "maintainer-jane",
		authorAssociation: "MEMBER",
		body: "nit: naming",
		createdAt: "2026-08-20T00:00:00Z",
		updatedAt: "2026-08-20T00:00:00Z",
		htmlUrl: "https://github.com/openclaw/openclaw/pull/7#discussion_21",
		...overrides,
	};
}

function review(overrides: Partial<GithubReviewSnapshot> = {}): GithubReviewSnapshot {
	return {
		nodeId: "PRR_1",
		id: 31,
		authorLogin: "maintainer-jane",
		authorAssociation: "MEMBER",
		state: "COMMENTED",
		body: "",
		submittedAt: "2026-08-20T00:00:00Z",
		commitId: "abc123",
		htmlUrl: "https://github.com/openclaw/openclaw/pull/7#pullrequestreview-31",
		...overrides,
	};
}

function checkRun(overrides: Partial<GithubCheckRunSnapshot> = {}): GithubCheckRunSnapshot {
	return {
		nodeId: "CHK_1",
		id: 41,
		name: "ci",
		status: "completed",
		conclusion: "success",
		startedAt: "2026-08-20T00:00:00Z",
		completedAt: "2026-08-20T00:05:00Z",
		detailsUrl: null,
		htmlUrl: "https://github.com/openclaw/openclaw/check-runs/41",
		...overrides,
	};
}

function base(overrides: Partial<AttentionDerivationInput> = {}): AttentionDerivationInput {
	return {
		pr: pr(),
		botLogin: BOT,
		expectedHeadSha: "abc123",
		policyChange: null,
		issueComments: [],
		reviewComments: [],
		reviews: [],
		checkRuns: [],
		combinedStatus: { state: "success", totalCount: 1, sha: "abc123", contexts: [] },
		deletedNodeIds: [],
		truncatedKinds: [],
		nowMs: NOW,
		staleAfterMs: STALE_AFTER,
		...overrides,
	};
}

function reasons(input: AttentionDerivationInput): AttentionReason[] {
	return deriveAttention(input).map((item) => item.reason);
}

describe("deriveAttention", () => {
	test("a clean open PR derives no attention", () => {
		expect(deriveAttention(base())).toEqual([]);
	});

	test("requested changes from a human reviewer, superseded by a later approval", () => {
		const requested = reasons(
			base({
				reviews: [review({ state: "CHANGES_REQUESTED", submittedAt: "2026-08-24T00:00:00Z" })],
			}),
		);
		expect(requested).toContain("requested_changes");

		const superseded = reasons(
			base({
				reviews: [
					review({
						nodeId: "PRR_1",
						state: "CHANGES_REQUESTED",
						submittedAt: "2026-08-20T00:00:00Z",
					}),
					review({ nodeId: "PRR_2", state: "APPROVED", submittedAt: "2026-08-24T00:00:00Z" }),
				],
			}),
		);
		expect(superseded).not.toContain("requested_changes");
	});

	test("bot self-reviews never raise requested changes", () => {
		const result = reasons(
			base({ reviews: [review({ authorLogin: BOT, state: "CHANGES_REQUESTED" })] }),
		);
		expect(result).toEqual([]);
	});

	test("maintainer comments raise maintainer_comment; drive-by comments do not", () => {
		expect(reasons(base({ issueComments: [issueComment()] }))).toContain("maintainer_comment");
		expect(reasons(base({ reviewComments: [reviewComment()] }))).toContain("maintainer_comment");
		expect(reasons(base({ issueComments: [issueComment({ authorAssociation: "NONE" })] }))).toEqual(
			[],
		);
		expect(reasons(base({ issueComments: [issueComment({ authorLogin: BOT })] }))).toEqual([]);
	});

	test("failing checks: failing runs, pending runs, and combined-status fallback", () => {
		expect(reasons(base({ checkRuns: [checkRun({ conclusion: "failure" })] }))).toContain(
			"failing_checks",
		);
		expect(reasons(base({ checkRuns: [checkRun({ conclusion: "timed_out" })] }))).toContain(
			"failing_checks",
		);
		// Pending checks are normal progress, not attention.
		expect(
			reasons(base({ checkRuns: [checkRun({ status: "in_progress", conclusion: null })] })),
		).toEqual([]);
		expect(reasons(base({ checkRuns: [checkRun({ conclusion: "cancelled" })] }))).toEqual([]);
		// Combined failure with no itemized failing run still surfaces.
		const combinedOnly = deriveAttention(
			base({
				combinedStatus: { state: "failure", totalCount: 1, sha: "abc123", contexts: [] },
			}),
		);
		expect(combinedOnly.map((item) => item.reason)).toEqual(["failing_checks"]);
		expect(combinedOnly[0]?.subjectKey).toBe("combined-status:abc123");
	});

	test("human takeover: non-bot PR author or an unexplained head movement", () => {
		expect(reasons(base({ pr: pr({ authorLogin: "human-helper" }) }))).toContain("human_takeover");
		expect(reasons(base({ pr: pr({ headSha: "fff999" }) }))).toContain("human_takeover");
		// No expected head configured: head movement alone proves nothing.
		expect(reasons(base({ expectedHeadSha: null, pr: pr({ headSha: "fff999" }) }))).toEqual([]);
	});

	test("policy change raises policy_change keyed by path", () => {
		const derived = deriveAttention(
			base({
				policyChange: { path: "CONTRIBUTING.md", expectedSha256: "a", actualSha256: "b" },
			}),
		);
		expect(derived.map((item) => item.reason)).toEqual(["policy_change"]);
		expect(derived[0]?.subjectKey).toBe("CONTRIBUTING.md");
	});

	test("stale author action only when feedback is old and the bot stayed silent", () => {
		const stale = reasons(base({ issueComments: [issueComment()] }));
		expect(stale).toContain("maintainer_comment");
		expect(stale).toContain("stale_author_action");

		// Recent feedback is not yet stale.
		const fresh = reasons(
			base({ issueComments: [issueComment({ createdAt: "2026-08-24T23:00:00Z" })] }),
		);
		expect(fresh).not.toContain("stale_author_action");

		// A bot reply newer than the feedback clears staleness.
		const answered = reasons(
			base({
				issueComments: [
					issueComment(),
					issueComment({ nodeId: "IC_2", authorLogin: BOT, createdAt: "2026-08-21T00:00:00Z" }),
				],
			}),
		);
		expect(answered).not.toContain("stale_author_action");
	});

	test("unknown vocabulary, deletions, and truncation raise unresolved ambiguity", () => {
		expect(reasons(base({ pr: pr({ state: "half-open" }) }))).toContain("unresolved_ambiguity");
		expect(reasons(base({ reviews: [review({ state: "WAT" })] }))).toContain(
			"unresolved_ambiguity",
		);
		expect(reasons(base({ checkRuns: [checkRun({ status: "teleporting" })] }))).toContain(
			"unresolved_ambiguity",
		);
		expect(reasons(base({ checkRuns: [checkRun({ conclusion: "exploded" })] }))).toContain(
			"unresolved_ambiguity",
		);
		expect(reasons(base({ deletedNodeIds: ["IC_7"] }))).toContain("unresolved_ambiguity");
		expect(reasons(base({ truncatedKinds: ["review"] }))).toContain("unresolved_ambiguity");
	});

	test("derivation is stable: identical input derives identical attention", () => {
		const input = base({
			reviews: [review({ state: "CHANGES_REQUESTED" })],
			issueComments: [issueComment()],
		});
		expect(deriveAttention(input)).toEqual(deriveAttention(input));
	});
});
