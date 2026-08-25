import { describe, expect, test } from "bun:test";
import { digestOf } from "../digest.ts";
import type { GithubIssueCommentSnapshot, GithubPullRequestSnapshot } from "../github/types.ts";
import {
	deletedEventOf,
	editEventOf,
	issueCommentEvent,
	prInaccessibleEvent,
	prStateEvent,
} from "./normalize.ts";

const REPO = "openclaw/openclaw";

function pr(overrides: Partial<GithubPullRequestSnapshot> = {}): GithubPullRequestSnapshot {
	return {
		nodeId: "PR_1",
		number: 7,
		state: "open",
		draft: false,
		title: "Fix the thing",
		authorLogin: "warren-run-bot",
		headRef: "warren/issue-42",
		headSha: "abc123",
		headRepoFullName: "warren-run-bot/openclaw",
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

function comment(overrides: Partial<GithubIssueCommentSnapshot> = {}): GithubIssueCommentSnapshot {
	return {
		nodeId: "IC_1",
		id: 11,
		authorLogin: "maintainer-jane",
		authorAssociation: "MEMBER",
		body: "please add a test",
		createdAt: "2026-08-03T00:00:00Z",
		updatedAt: "2026-08-03T00:00:00Z",
		htmlUrl: "https://github.com/openclaw/openclaw/issues/7#issuecomment-11",
		...overrides,
	};
}

describe("normalize", () => {
	test("normalized events carry repository, pr number, and a stable digest", () => {
		const first = issueCommentEvent(REPO, 7, comment());
		const second = issueCommentEvent(REPO, 7, comment());
		expect(first.kind).toBe("issue_comment");
		expect(first.repository).toBe(REPO);
		expect(first.payload.prNumber).toBe(7);
		expect(first.payloadDigest).toBe(second.payloadDigest);
		expect(first.payloadDigest).toBe(digestOf(first.payloadJson));
	});

	test("an edited snapshot keeps the node id but changes the digest", () => {
		const before = issueCommentEvent(REPO, 7, comment());
		const after = issueCommentEvent(REPO, 7, comment({ body: "please add two tests" }));
		expect(after.nodeId).toBe(before.nodeId);
		expect(after.payloadDigest).not.toBe(before.payloadDigest);
	});

	test("edit events derive a stable synthetic node id and keep the base digest", () => {
		const base = issueCommentEvent(REPO, 7, comment({ body: "edited" }));
		const edit = editEventOf(base);
		expect(edit.kind).toBe("issue_comment_edit");
		expect(edit.nodeId).toBe(`IC_1#edit#${base.payloadDigest}`);
		expect(edit.payload.editsNodeId).toBe("IC_1");
		// The edit row carries the edited fact's digest so a re-poll of the
		// same edited content dedupes against it.
		expect(edit.payloadDigest).toBe(base.payloadDigest);
	});

	test("reordered snapshots normalize identically regardless of array order", () => {
		const events = [comment({ nodeId: "IC_1", id: 1 }), comment({ nodeId: "IC_2", id: 2 })];
		const forward = events.map((c) => issueCommentEvent(REPO, 7, c).payloadDigest);
		const reverse = [...events].reverse().map((c) => issueCommentEvent(REPO, 7, c).payloadDigest);
		expect([...forward].sort()).toEqual([...reverse].sort());
	});

	test("deletion tombstones and pr-inaccessible facts have stable synthetic ids", () => {
		const tombstone = deletedEventOf("review", "PRR_9", REPO, 7);
		expect(tombstone.kind).toBe("review_deleted");
		expect(tombstone.nodeId).toBe("deleted:PRR_9");
		expect(tombstone.payload.deletedNodeId).toBe("PRR_9");

		const inaccessible = prInaccessibleEvent(REPO, 7);
		expect(inaccessible.kind).toBe("pr_inaccessible");
		expect(inaccessible.nodeId).toBe("pr:openclaw/openclaw#7");
		expect(inaccessible.payload.accessible).toBe(false);
	});

	test("pr state events digest the identity-relevant fields", () => {
		const base = prStateEvent(REPO, pr());
		const sameState = prStateEvent(REPO, pr({ title: "retitled upstream" }));
		expect(sameState.payloadDigest).toBe(base.payloadDigest);
		const headMoved = prStateEvent(REPO, pr({ headSha: "fff999" }));
		expect(headMoved.payloadDigest).not.toBe(base.payloadDigest);
	});
});
