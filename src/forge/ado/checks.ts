/**
 * Azure DevOps Pipelines → `CheckSummary` mapping.
 *
 * A pipeline build is the closest thing Azure DevOps has to a check run:
 * one row per definition per commit, with a status (`notStarted`,
 * `inProgress`, `completed`, …) and, once complete, a result
 * (`succeeded`, `partiallySucceeded`, `failed`, `canceled`). The build id
 * is the opaque `jobId` the log tail is fetched by.
 */

import type { CheckRun, CheckSummary } from "../contract.ts";

/** Conclusions the CI rollup counts as `failing`. A partial success still means a task failed. */
const FAILURE_RESULTS: ReadonlySet<string> = new Set(["failure", "cancelled"]);

/**
 * Azure DevOps build results, folded to the check-run conclusion
 * vocabulary the ci-fixer classifier matches on. An unmapped result
 * passes through raw and classifies as non-failing, the same posture the
 * classifier takes toward an unknown GitHub conclusion.
 */
const CONCLUSIONS: Readonly<Record<string, string>> = {
	succeeded: "success",
	partiallySucceeded: "failure",
	failed: "failure",
	canceled: "cancelled",
};

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

interface BuildJson {
	readonly id?: unknown;
	readonly status?: unknown;
	readonly result?: unknown;
	readonly sourceVersion?: unknown;
	readonly sourceBranch?: unknown;
	readonly definition?: unknown;
	readonly repository?: unknown;
	readonly _links?: unknown;
}

/** Map one build row to a check run; `null` when the row is unreadable. */
export function parseBuild(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const build = raw as BuildJson;
	if (typeof build.id !== "number") return null;
	const definition = build.definition as { name?: unknown } | undefined;
	const links = build._links as { web?: { href?: unknown } } | undefined;
	return {
		name: typeof definition?.name === "string" ? definition.name : "",
		status: checkStatus(build.status),
		conclusion:
			typeof build.result === "string" ? (CONCLUSIONS[build.result] ?? build.result) : null,
		jobId: String(build.id),
		detailsUrl: typeof links?.web?.href === "string" ? links.web.href : null,
	};
}

/**
 * True when the build row ran against `ref` in the repository named
 * `repo`. `ref` is a commit SHA or a branch name — the contract passes a
 * commit, but the ci-fixer polls by run branch, and the GitHub arm's
 * endpoint accepts either, so this arm matches both shapes too.
 */
export function buildMatches(raw: unknown, repo: string, ref: string): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	const build = raw as BuildJson;
	const wanted = COMMIT_SHA.test(ref) ? build.sourceVersion === ref : matchesBranch(build, ref);
	if (!wanted) return false;
	const repository = build.repository as { name?: unknown } | undefined;
	return typeof repository?.name === "string" ? repository.name === repo : true;
}

/** The refs/heads/ prefix a branch ref carries on a build row. */
export function branchFilter(branch: string): string {
	return `refs/heads/${branch}`;
}

function matchesBranch(build: BuildJson, branch: string): boolean {
	return build.sourceBranch === branchFilter(branch);
}

/** True when `ref` is a full commit SHA rather than a branch name. */
export function isCommitSha(ref: string): boolean {
	return COMMIT_SHA.test(ref);
}

function checkStatus(status: unknown): CheckRun["status"] {
	if (status === "notStarted" || status === "postponed") return "queued";
	if (status === "completed") return "completed";
	return "in_progress";
}

/** Roll a commit's builds up to the domain's decision input. */
export function rollUp(runs: CheckRun[]): CheckSummary["conclusion"] {
	if (runs.length === 0) return "unknown";
	if (runs.some((r) => r.status !== "completed")) return "pending";
	if (runs.some((r) => r.conclusion !== null && FAILURE_RESULTS.has(r.conclusion))) {
		return "failing";
	}
	return "passing";
}

/**
 * Pick the log worth tailing out of a build timeline: the first failed
 * task that wrote a log, else the last record with a log. `null` when the
 * timeline carries no log at all.
 */
export function pickTimelineLogId(timeline: unknown): number | null {
	const records = (timeline as { records?: unknown } | null)?.records;
	if (!Array.isArray(records)) return null;
	let last: number | null = null;
	for (const raw of records) {
		const record = raw as { type?: unknown; result?: unknown; log?: { id?: unknown } } | null;
		const logId = record?.log?.id;
		if (typeof logId !== "number") continue;
		if (record?.type === "Task" && record.result === "failed") return logId;
		last = logId;
	}
	return last;
}
