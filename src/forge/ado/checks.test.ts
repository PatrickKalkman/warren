import { describe, expect, test } from "bun:test";
import type { CheckRun } from "../contract.ts";
import { buildMatches, parseBuild, pickTimelineLogId, rollUp } from "./checks.ts";

function run(overrides: Partial<CheckRun> = {}): CheckRun {
	return {
		name: "ci",
		status: "completed",
		conclusion: "succeeded",
		jobId: "1",
		detailsUrl: null,
		...overrides,
	};
}

describe("parseBuild", () => {
	test("maps a build row onto a check run with the build id as jobId", () => {
		expect(
			parseBuild({
				id: 42,
				status: "completed",
				result: "failed",
				definition: { name: "CI" },
				_links: { web: { href: "https://dev.azure.com/acme/_build/results?buildId=42" } },
			}),
		).toEqual({
			name: "CI",
			status: "completed",
			conclusion: "failed",
			jobId: "42",
			detailsUrl: "https://dev.azure.com/acme/_build/results?buildId=42",
		});
	});

	test("maps the build status vocabulary", () => {
		expect(parseBuild({ id: 1, status: "notStarted" })?.status).toBe("queued");
		expect(parseBuild({ id: 1, status: "postponed" })?.status).toBe("queued");
		expect(parseBuild({ id: 1, status: "inProgress" })?.status).toBe("in_progress");
		expect(parseBuild({ id: 1, status: "cancelling" })?.status).toBe("in_progress");
		expect(parseBuild({ id: 1, status: "completed" })?.conclusion).toBeNull();
	});

	test("returns null for a row without a numeric id", () => {
		expect(parseBuild({ status: "completed" })).toBeNull();
		expect(parseBuild(null)).toBeNull();
	});
});

describe("buildMatches", () => {
	test("matches on sourceVersion and, when named, the repository", () => {
		expect(
			buildMatches({ sourceVersion: "abc", repository: { name: "widget" } }, "widget", "abc"),
		).toBe(true);
		expect(
			buildMatches({ sourceVersion: "abc", repository: { name: "other" } }, "widget", "abc"),
		).toBe(false);
		expect(buildMatches({ sourceVersion: "abc" }, "widget", "abc")).toBe(true);
		expect(buildMatches({ sourceVersion: "def" }, "widget", "abc")).toBe(false);
		expect(buildMatches(null, "widget", "abc")).toBe(false);
	});
});

describe("rollUp", () => {
	test("no builds is unknown, an incomplete one is pending", () => {
		expect(rollUp([])).toBe("unknown");
		expect(rollUp([run(), run({ status: "in_progress", conclusion: null })])).toBe("pending");
	});

	test("failed, canceled and partially succeeded all count as failing", () => {
		expect(rollUp([run(), run({ conclusion: "failed" })])).toBe("failing");
		expect(rollUp([run({ conclusion: "canceled" })])).toBe("failing");
		expect(rollUp([run({ conclusion: "partiallySucceeded" })])).toBe("failing");
		expect(rollUp([run(), run()])).toBe("passing");
	});
});

describe("pickTimelineLogId", () => {
	test("prefers the first failed task's log", () => {
		expect(
			pickTimelineLogId({
				records: [
					{ type: "Job", result: "failed", log: { id: 1 } },
					{ type: "Task", result: "succeeded", log: { id: 2 } },
					{ type: "Task", result: "failed", log: { id: 3 } },
					{ type: "Task", result: "failed", log: { id: 4 } },
				],
			}),
		).toBe(3);
	});

	test("falls back to the last record with a log", () => {
		expect(
			pickTimelineLogId({
				records: [
					{ type: "Task", log: { id: 5 } },
					{ type: "Task", log: { id: 6 } },
					{ type: "Task" },
				],
			}),
		).toBe(6);
	});

	test("returns null when nothing carries a log", () => {
		expect(pickTimelineLogId({ records: [{ type: "Task" }] })).toBeNull();
		expect(pickTimelineLogId(null)).toBeNull();
		expect(pickTimelineLogId({})).toBeNull();
	});
});
