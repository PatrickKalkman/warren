import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { type ReconcilePullRequestInput, UpstreamPrReconciler } from "./reconciler.ts";

const NOW = Date.parse("2026-08-25T00:00:00Z");
const BOT = "warren-run-bot";
const OWNER = "openclaw";
const REPO = "openclaw";
const FULL = "openclaw/openclaw";
const PR_NUMBER = 7;
const SHA = "abc123";

const PR_PATH = `/repos/${FULL}/pulls/${PR_NUMBER}`;
const ISSUE_COMMENTS_PATH = `/repos/${FULL}/issues/${PR_NUMBER}/comments`;
const REVIEWS_PATH = `/repos/${FULL}/pulls/${PR_NUMBER}/reviews`;
const REVIEW_COMMENTS_PATH = `/repos/${FULL}/pulls/${PR_NUMBER}/comments`;
const CHECK_RUNS_PATH = `/repos/${FULL}/commits/${SHA}/check-runs`;
const STATUS_PATH = `/repos/${FULL}/commits/${SHA}/status`;

let tempDir: string | null = null;

afterEach(() => {
	if (tempDir !== null && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	tempDir = null;
});

function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 900,
		node_id: "PR_1",
		number: PR_NUMBER,
		state: "open",
		draft: false,
		title: "Fix the thing",
		user: { login: BOT },
		head: { ref: "warren/issue-42", sha: SHA, repo: { full_name: `${BOT}/openclaw` } },
		base: { ref: "main", sha: "def456", repo: { full_name: FULL } },
		merged_at: null,
		closed_at: null,
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-02T00:00:00Z",
		html_url: `https://github.com/${FULL}/pull/${PR_NUMBER}`,
		...overrides,
	};
}

function issueComment(
	nodeId: string,
	author: string,
	association: string,
	body: string,
	createdAt = "2026-08-24T23:00:00Z",
): Record<string, unknown> {
	return {
		id: 1000 + nodeId.length,
		node_id: nodeId,
		user: { login: author },
		author_association: association,
		body,
		created_at: createdAt,
		updated_at: createdAt,
		html_url: `https://github.com/${FULL}/issues/${PR_NUMBER}#issuecomment-${nodeId}`,
	};
}

function review(
	nodeId: string,
	author: string,
	association: string,
	state: string,
	submittedAt = "2026-08-20T00:00:00Z",
): Record<string, unknown> {
	return {
		id: 2000 + nodeId.length,
		node_id: nodeId,
		user: { login: author },
		author_association: association,
		state,
		body: "",
		submitted_at: submittedAt,
		commit_id: SHA,
		html_url: `https://github.com/${FULL}/pull/${PR_NUMBER}#pullrequestreview-${nodeId}`,
	};
}

function reviewComment(
	nodeId: string,
	author: string,
	association: string,
	body: string,
): Record<string, unknown> {
	return {
		id: 3000 + nodeId.length,
		node_id: nodeId,
		user: { login: author },
		author_association: association,
		body,
		created_at: "2026-08-20T00:00:00Z",
		updated_at: "2026-08-20T00:00:00Z",
		html_url: `https://github.com/${FULL}/pull/${PR_NUMBER}#discussion_${nodeId}`,
	};
}

function checkRun(
	nodeId: string,
	name: string,
	status: string,
	conclusion: string | null,
): Record<string, unknown> {
	return {
		id: 4000 + nodeId.length,
		node_id: nodeId,
		name,
		status,
		conclusion,
		started_at: "2026-08-20T00:00:00Z",
		completed_at: status === "completed" ? "2026-08-20T00:05:00Z" : null,
		details_url: null,
		html_url: `https://github.com/${FULL}/check-runs/${nodeId}`,
	};
}

function statusBody(state: string): Record<string, unknown> {
	return { state, total_count: 1, sha: SHA, statuses: [] };
}

interface Wired {
	server: FakeGithubServer;
	client: ReadOnlyGithubClient;
	store: CampaignStateStore;
	reconciler: UpstreamPrReconciler;
	input: ReconcilePullRequestInput;
}

function wire(
	serverData: {
		pr?: Record<string, unknown>;
		issueComments?: Record<string, unknown>[];
		reviews?: Record<string, unknown>[];
		reviewComments?: Record<string, unknown>[];
		checkRuns?: Record<string, unknown>[];
		status?: Record<string, unknown>;
	} = {},
	options: { perPage?: number; reconcile?: Partial<ReconcilePullRequestInput> } = {},
): Wired {
	const clock = new FixedClock(NOW);
	const store = new CampaignStateStore(":memory:", {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({ manifestDigest: "d", manifestJson: "{}" });
	const server = new FakeGithubServer({ clock });
	server.setResource(PR_PATH, serverData.pr ?? prBody());
	server.setPaginatedCollection(ISSUE_COMMENTS_PATH, serverData.issueComments ?? []);
	server.setPaginatedCollection(REVIEWS_PATH, serverData.reviews ?? []);
	server.setPaginatedCollection(REVIEW_COMMENTS_PATH, serverData.reviewComments ?? []);
	server.setResource(CHECK_RUNS_PATH, {
		total_count: (serverData.checkRuns ?? []).length,
		check_runs: serverData.checkRuns ?? [],
	});
	server.setResource(STATUS_PATH, serverData.status ?? statusBody("success"));
	const client = new ReadOnlyGithubClient(server, { perPage: options.perPage ?? 100 });
	const reconciler = new UpstreamPrReconciler({ client, store, clock });
	const input: ReconcilePullRequestInput = {
		campaignId: campaign.id,
		owner: OWNER,
		repo: REPO,
		pullNumber: PR_NUMBER,
		botLogin: BOT,
		...options.reconcile,
	};
	return { server, client, store, reconciler, input };
}

function expectOnlyReads(server: FakeGithubServer): void {
	expect(server.requestCount).toBeGreaterThan(0);
	for (const request of server.recordedRequests()) {
		expect(["GET", "HEAD"]).toContain(request.method);
	}
}

function openReasons(wired: Wired): string[] {
	return wired.store.events.listOpenAttention(wired.input.campaignId).map((item) => item.reason);
}

describe("UpstreamPrReconciler core ingestion", () => {
	test("reconciles authoritative state into deduped durable events via GET/HEAD only", async () => {
		const wired = wire({
			issueComments: [issueComment("IC_1", "maintainer-jane", "MEMBER", "add a test")],
			reviews: [review("PRR_1", "maintainer-jane", "MEMBER", "COMMENTED")],
			reviewComments: [reviewComment("RC_1", "maintainer-jane", "MEMBER", "nit here")],
			checkRuns: [checkRun("CHK_1", "ci", "completed", "success")],
		});
		const result = await wired.reconciler.reconcilePullRequest(wired.input);
		expect(result.status).toBe("reconciled");
		expect(result.newEvents).toBe(6);
		expect(result.duplicateEvents).toBe(0);
		expect(result.headSha).toBe(SHA);
		expect(wired.store.events.getGithubEvent("PR_1")?.eventKind).toBe("pr_state");
		expect(wired.store.events.getGithubEvent("IC_1")?.repository).toBe(FULL);
		expect(wired.store.events.getGithubEvent("CHK_1")?.payloadDigest).not.toBe("");
		expect(wired.store.cursors.getCursor(`pr-reconcile:${FULL}#7`)?.checkpointJson).toContain(SHA);
		expectOnlyReads(wired.server);
	});

	test("a second poll over unchanged state is all duplicates and adds no attention", async () => {
		const wired = wire({
			issueComments: [issueComment("IC_1", "maintainer-jane", "MEMBER", "add a test")],
		});
		await wired.reconciler.reconcilePullRequest(wired.input);
		const before = wired.store.events.listGithubEvents(wired.input.campaignId).length;
		const second = await wired.reconciler.reconcilePullRequest(wired.input);
		expect(second.newEvents).toBe(0);
		expect(second.editedEvents).toBe(0);
		expect(second.duplicateEvents).toBeGreaterThan(0);
		expect(second.attentionAdded).toHaveLength(0);
		expect(wired.store.events.listGithubEvents(wired.input.campaignId)).toHaveLength(before);
		expect(wired.store.events.listOpenAttention(wired.input.campaignId)).toHaveLength(1);
	});

	test("dedupe holds across paginated reads and reordered pages", async () => {
		const wired = wire(
			{
				issueComments: [
					issueComment("IC_1", "maintainer-jane", "MEMBER", "first"),
					issueComment("IC_2", "contributor-tom", "NONE", "second"),
					issueComment("IC_3", BOT, "NONE", "bot note"),
				],
			},
			{ perPage: 1 },
		);
		const first = await wired.reconciler.reconcilePullRequest(wired.input);
		expect(first.newEvents).toBe(5); // pr_state + 3 comments + combined_status
		// Reordered pages deliver the same node ids in a different order.
		wired.server.mutateResource(ISSUE_COMMENTS_PATH, [
			issueComment("IC_3", BOT, "NONE", "bot note"),
			issueComment("IC_1", "maintainer-jane", "MEMBER", "first"),
			issueComment("IC_2", "contributor-tom", "NONE", "second"),
		]);
		const second = await wired.reconciler.reconcilePullRequest(wired.input);
		expect(second.newEvents).toBe(0);
		expect(second.editedEvents).toBe(0);
		expect(wired.store.events.listOpenAttention(wired.input.campaignId)).toHaveLength(1);
		expectOnlyReads(wired.server);
	});

	test("an upstream edit appends an edit fact without erasing the original", async () => {
		const wired = wire({
			issueComments: [issueComment("IC_1", "maintainer-jane", "MEMBER", "add a test")],
		});
		await wired.reconciler.reconcilePullRequest(wired.input);
		wired.server.mutateResource(ISSUE_COMMENTS_PATH, [
			issueComment("IC_1", "maintainer-jane", "MEMBER", "add TWO tests"),
		]);
		const result = await wired.reconciler.reconcilePullRequest(wired.input);
		expect(result.editedEvents).toBe(1);
		const original = wired.store.events.getGithubEvent("IC_1");
		expect(original?.eventKind).toBe("issue_comment");
		expect(original?.payloadJson).toContain("add a test");
		const edits = wired.store.events
			.listGithubEvents(wired.input.campaignId, "issue_comment_edit")
			.filter((row) => row.nodeId.startsWith("IC_1#edit#"));
		expect(edits).toHaveLength(1);
		expect(edits[0]?.payloadJson).toContain("add TWO tests");
		// Re-polling the edited content dedupes instead of re-editing.
		const third = await wired.reconciler.reconcilePullRequest(wired.input);
		expect(third.editedEvents).toBe(0);
	});

	test("a deleted comment becomes a tombstone and unresolved ambiguity", async () => {
		const wired = wire({
			issueComments: [
				issueComment("IC_1", "maintainer-jane", "MEMBER", "first"),
				issueComment("IC_2", "maintainer-jane", "MEMBER", "second"),
			],
		});
		await wired.reconciler.reconcilePullRequest(wired.input);
		wired.server.mutateResource(ISSUE_COMMENTS_PATH, [
			issueComment("IC_1", "maintainer-jane", "MEMBER", "first"),
		]);
		const result = await wired.reconciler.reconcilePullRequest(wired.input);
		const tombstones = wired.store.events.listGithubEvents(
			wired.input.campaignId,
			"issue_comment_deleted",
		);
		expect(tombstones).toHaveLength(1);
		expect(tombstones[0]?.nodeId).toBe("deleted:IC_2");
		// The deleted fact's history row survives.
		expect(wired.store.events.getGithubEvent("IC_2")).not.toBeNull();
		const ambiguity = result.attentionAdded.filter(
			(item) => item.reason === "unresolved_ambiguity",
		);
		expect(ambiguity.length).toBeGreaterThan(0);
	});

	test("a 404 on the PR becomes an explicit inaccessible fact, never erased state", async () => {
		const empty = new FakeGithubServer();
		const clock = new FixedClock(NOW);
		const store = new CampaignStateStore(":memory:", {
			clock,
			ids: new SequentialIdGenerator(),
		});
		const campaign = store.campaigns.createCampaign({ manifestDigest: "d", manifestJson: "{}" });
		const reconciler = new UpstreamPrReconciler({
			client: new ReadOnlyGithubClient(empty),
			store,
			clock,
		});
		const result = await reconciler.reconcilePullRequest({
			campaignId: campaign.id,
			owner: OWNER,
			repo: REPO,
			pullNumber: PR_NUMBER,
			botLogin: BOT,
		});
		expect(result.status).toBe("pr_inaccessible");
		expect(store.events.getGithubEvent(`pr:${FULL}#7`)?.eventKind).toBe("pr_inaccessible");
		expect(result.attentionAdded.map((item) => item.reason)).toContain("unresolved_ambiguity");
		expect(store.cursors.getCursor(`pr-reconcile:${FULL}#7`)?.checkpointJson).toContain(
			"pr_inaccessible",
		);
		expectOnlyReads(empty);
	});

	test("restart recovery: a reopened store replays nothing and adds no attention", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "reconcile-restart-"));
		const dbPath = join(tempDir, "state.db");
		const clock = new FixedClock(NOW);
		const server = new FakeGithubServer({ clock });
		server.setResource(PR_PATH, prBody());
		server.setPaginatedCollection(ISSUE_COMMENTS_PATH, [
			issueComment("IC_1", "maintainer-jane", "MEMBER", "add a test"),
		]);
		server.setPaginatedCollection(REVIEWS_PATH, [
			review("PRR_1", "maintainer-jane", "MEMBER", "CHANGES_REQUESTED"),
		]);
		server.setPaginatedCollection(REVIEW_COMMENTS_PATH, []);
		server.setResource(CHECK_RUNS_PATH, { total_count: 0, check_runs: [] });
		server.setResource(STATUS_PATH, statusBody("success"));

		const firstStore = new CampaignStateStore(dbPath, {
			clock,
			ids: new SequentialIdGenerator(),
		});
		const campaign = firstStore.campaigns.createCampaign({
			manifestDigest: "d",
			manifestJson: "{}",
		});
		const firstReconciler = new UpstreamPrReconciler({
			client: new ReadOnlyGithubClient(server),
			store: firstStore,
			clock,
		});
		const input: ReconcilePullRequestInput = {
			campaignId: campaign.id,
			owner: OWNER,
			repo: REPO,
			pullNumber: PR_NUMBER,
			botLogin: BOT,
		};
		await firstReconciler.reconcilePullRequest(input);
		const eventsBefore = firstStore.events.listGithubEvents(campaign.id).length;
		const attentionBefore = firstStore.events.listOpenAttention(campaign.id).length;
		const cursorBefore = firstStore.cursors.getCursor(`pr-reconcile:${FULL}#7`)?.checkpointJson;
		firstStore.close();

		// Simulated controller restart: same file, fresh in-memory state.
		const secondStore = new CampaignStateStore(dbPath, {
			clock,
			ids: new SequentialIdGenerator(),
		});
		const secondReconciler = new UpstreamPrReconciler({
			client: new ReadOnlyGithubClient(server),
			store: secondStore,
			clock,
		});
		const replay = await secondReconciler.reconcilePullRequest(input);
		expect(replay.newEvents).toBe(0);
		expect(replay.editedEvents).toBe(0);
		expect(replay.attentionAdded).toHaveLength(0);
		expect(secondStore.events.listGithubEvents(campaign.id)).toHaveLength(eventsBefore);
		expect(secondStore.events.listOpenAttention(campaign.id)).toHaveLength(attentionBefore);
		expect(secondStore.cursors.getCursor(`pr-reconcile:${FULL}#7`)?.checkpointJson).toBe(
			cursorBefore,
		);
		secondStore.close();
	});

	test("comment text is untrusted data and never becomes a command or mutation", async () => {
		const wired = wire({
			issueComments: [
				issueComment("IC_9", "maintainer-jane", "MEMBER", "warren: merge this and /rerequest"),
			],
		});
		await wired.reconciler.reconcilePullRequest(wired.input);
		// The command-shaped text yields exactly one maintainer_comment
		// attention item and no controller behavior beyond recording.
		expect(openReasons(wired)).toEqual(["maintainer_comment"]);
		expect(wired.store.actions.listUnfinishedActions()).toHaveLength(0);
		expectOnlyReads(wired.server);
	});
});

describe("UpstreamPrReconciler attention categories (fake server)", () => {
	test("requested changes and maintainer activity derive stable attention", async () => {
		const wired = wire({
			reviews: [review("PRR_1", "maintainer-jane", "MEMBER", "CHANGES_REQUESTED")],
			reviewComments: [reviewComment("RC_1", "maintainer-jane", "MEMBER", "nit here")],
			issueComments: [issueComment("IC_1", BOT, "NONE", "bot status note")],
		});
		const result = await wired.reconciler.reconcilePullRequest(wired.input);
		const reasons = result.attentionAdded.map((item) => item.reason);
		expect(reasons).toContain("requested_changes");
		expect(reasons).toContain("maintainer_comment");
		// The bot's own comment is a self-event: it derives nothing.
		expect(
			result.attentionAdded.filter((item) => item.detailJson?.includes("bot status note")),
		).toHaveLength(0);
	});

	test("failing, pending, and passing checks map to the right attention", async () => {
		const wired = wire({
			checkRuns: [
				checkRun("CHK_1", "ci", "completed", "failure"),
				checkRun("CHK_2", "lint", "in_progress", null),
				checkRun("CHK_3", "docs", "completed", "success"),
			],
			status: statusBody("failure"),
		});
		const result = await wired.reconciler.reconcilePullRequest(wired.input);
		const failing = result.attentionAdded.filter((item) => item.reason === "failing_checks");
		expect(failing).toHaveLength(1);
		expect(failing[0]?.detailJson).toContain("CHK_1");
	});

	test("an unexplained head movement raises human_takeover", async () => {
		const wired = wire({}, { reconcile: { expectedHeadSha: "the-sha-the-controller-pushed" } });
		const result = await wired.reconciler.reconcilePullRequest(wired.input);
		const takeover = result.attentionAdded.filter((item) => item.reason === "human_takeover");
		expect(takeover).toHaveLength(1);
		expect(takeover[0]?.detailJson).toContain(SHA);
	});

	test("pinned policy content drift raises policy_change; a match stays quiet", async () => {
		const { digestOf } = await import("../digest.ts");
		const policyPath = "/repos/openclaw/openclaw/contents/CONTRIBUTING.md";
		const content = Buffer.from("contribution guide v2", "utf8").toString("base64");
		const wired = wire();
		wired.server.setResource(policyPath, {
			path: "CONTRIBUTING.md",
			encoding: "base64",
			content,
		});
		const drift = await wired.reconciler.reconcilePullRequest({
			...wired.input,
			expectedPolicy: { path: "CONTRIBUTING.md", contentSha256: digestOf("contribution guide v1") },
		});
		expect(drift.attentionAdded.map((item) => item.reason)).toEqual(["policy_change"]);

		const quiet = wire();
		quiet.server.setResource(policyPath, {
			path: "CONTRIBUTING.md",
			encoding: "base64",
			content,
		});
		const match = await quiet.reconciler.reconcilePullRequest({
			...quiet.input,
			expectedPolicy: { path: "CONTRIBUTING.md", contentSha256: digestOf("contribution guide v2") },
		});
		expect(match.attentionAdded).toHaveLength(0);
	});
});

describe("UpstreamPrReconciler notification wake-ups", () => {
	test("participating notifications dedupe and reduce to PR reconcile targets", async () => {
		const wired = wire();
		wired.server.setPaginatedCollection("/notifications", [
			{
				id: "N_1",
				reason: "review_requested",
				updated_at: "2026-08-24T00:00:00Z",
				subject: {
					type: "PullRequest",
					title: "Fix the thing",
					url: `https://api.github.com/repos/${FULL}/pulls/7`,
				},
				repository: { full_name: FULL },
			},
			{
				id: "N_1", // at-least-once redelivery
				reason: "review_requested",
				updated_at: "2026-08-24T00:00:00Z",
				subject: {
					type: "PullRequest",
					title: "Fix the thing",
					url: `https://api.github.com/repos/${FULL}/pulls/7`,
				},
				repository: { full_name: FULL },
			},
		]);
		const wakeUps = await wired.reconciler.collectNotificationWakeUps(wired.input.campaignId);
		expect(wakeUps).toEqual([
			{ repositoryFullName: FULL, pullNumber: 7, reason: "review_requested" },
		]);
		expect(
			wired.store.events.listGithubEvents(wired.input.campaignId, "notification"),
		).toHaveLength(1);
		const again = await wired.reconciler.collectNotificationWakeUps(wired.input.campaignId);
		expect(again).toHaveLength(1);
		expect(
			wired.store.events.listGithubEvents(wired.input.campaignId, "notification"),
		).toHaveLength(1);
		expectOnlyReads(wired.server);
	});
});
