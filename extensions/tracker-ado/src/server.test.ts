/**
 * The warren-tracker/v1 surface, driven against FakeAdo.
 *
 * These cover the protocol obligations that are easy to get wrong on a
 * tracker whose terminal states are defined per process: idempotent
 * close, the reserved `issue_not_found` code on both paths, and the error
 * mapping that keeps an Azure DevOps credential failure from reading as
 * a warren credential failure. The suite in
 * `@warren-ext/tracker-conformance` is the authority; these are the cases
 * worth failing fast on before it runs.
 */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { createFakeAdo, type FakeAdoOptions, SAMPLE_ITEMS } from "./fake-ado.ts";
import { createAdoTrackerHandler } from "./server.ts";

function harness(options: Partial<FakeAdoOptions> = {}, env: Record<string, string> = {}) {
	const ado = createFakeAdo({ items: SAMPLE_ITEMS, ...options });
	const config = loadConfig({
		ADO_ORG_URL: "https://dev.azure.com/acme",
		ADO_PROJECT: "Platform",
		ADO_PAT: "pat-123",
		ADO_WIQL: "SELECT [System.Id] FROM WorkItems",
		...env,
	});
	const handler = createAdoTrackerHandler({ config, fetchImpl: ado.fetchImpl });
	const call = (method: string, path: string, headers: Record<string, string> = {}) =>
		handler(new Request(`http://tracker${path}`, { method, headers }));
	return { ado, call };
}

describe("GET /capabilities", () => {
	test("negotiates warren-tracker/v1 and declares the base contract only", async () => {
		const { call } = harness();
		const response = await call("GET", "/capabilities");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			protocolVersion: "warren-tracker/v1",
			capabilities: {
				supportsPlans: false,
				supportsMetadata: false,
				supportsScheduledIssues: false,
				isGitNative: false,
			},
		});
	});

	test("answers without touching Azure DevOps, so a boot probe needs no credential round trip", async () => {
		const { ado, call } = harness();
		await call("GET", "/capabilities");
		expect(ado.calls).toEqual([]);
	});
});

describe("GET /issues/{id}", () => {
	test("maps a work item onto the wire shape", async () => {
		const { call } = harness();
		const body = await (await call("GET", "/issues/96379")).json();
		expect(body).toEqual({
			id: "96379",
			status: "New",
			title: "Show crop from shared groups",
			description:
				"A grower who joined a shared group sees no crop on the dashboard.\n\nReproduced on test twice.\n\nAcceptance criteria:\nCrop is listed for shared groups\nOwn groups unchanged",
			blockedBy: ["96380"],
		});
	});

	test("answers a missing id with the reserved code", async () => {
		const { call } = harness();
		const response = await call("GET", "/issues/404404");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: "issue_not_found", message: "issue not found: 404404" },
		});
	});

	test("answers an id that is not a work item number with the reserved code, without asking", async () => {
		const { ado, call } = harness();
		const response = await call("GET", "/issues/WAR-1");
		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "issue_not_found" },
		});
		expect(ado.calls).toEqual([]);
	});
});

describe("GET /issue-statuses", () => {
	test("returns the raw id to state map for the configured query", async () => {
		const { call } = harness();
		const body = (await (await call("GET", "/issue-statuses")).json()) as {
			statuses: Record<string, string>;
		};
		expect(body.statuses).toEqual({ "96379": "New", "96380": "Active", "96381": "Closed" });
	});

	test("reads states in batches rather than one call per item", async () => {
		const { ado, call } = harness({}, { ADO_BATCH_SIZE: "2" });
		const body = (await (await call("GET", "/issue-statuses")).json()) as {
			statuses: Record<string, string>;
		};
		expect(Object.keys(body.statuses)).toHaveLength(3);
		expect(ado.calls.filter((c) => c.endsWith("/workitemsbatch"))).toHaveLength(2);
	});

	test("fails loud rather than truncating when the query selects too much", async () => {
		const { call } = harness({}, { ADO_MAX_WIQL_RESULTS: "2" });
		const response = await call("GET", "/issue-statuses");
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
			/ADO_MAX_WIQL_RESULTS/,
		);
	});
});

describe("POST /issues/{id}/close", () => {
	test("moves the work item into the Completed category", async () => {
		const { ado, call } = harness();
		const response = await call("POST", "/issues/96379/close");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "96379", status: "Closed" });
		expect(ado.items.get(96379)?.state).toBe("Closed");
	});

	test("answers 200 and changes nothing when the work item is already closed", async () => {
		const { ado, call } = harness();
		const first = await call("POST", "/issues/96379/close");
		const before = ado.calls.length;
		const second = await call("POST", "/issues/96379/close");

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ id: "96379", status: "Closed" });
		// The second close reads the work item and stops there: the states
		// come from memory and no PATCH goes out.
		expect(ado.calls.slice(before)).toEqual(["GET /acme/Platform/_apis/wit/workitems/96379"]);
	});

	test("leaves a removed work item where it is", async () => {
		const { ado, call } = harness({
			items: [{ id: 1, type: "Task", title: "Dropped", state: "Removed" }],
		});
		const response = await call("POST", "/issues/1/close");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "1", status: "Removed" });
		expect(ado.items.get(1)?.state).toBe("Removed");
	});

	test("uses the state an operator named", async () => {
		const { ado, call } = harness({}, { ADO_DONE_STATE: "resolved" });
		await call("POST", "/issues/96379/close");
		expect(ado.items.get(96379)?.state).toBe("Resolved");
	});

	test("answers 409 when the process defines no terminal state", async () => {
		const { call } = harness({
			states: [
				{ name: "New", category: "Proposed" },
				{ name: "Active", category: "InProgress" },
			],
		});
		const response = await call("POST", "/issues/96379/close");
		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "no_close_state" },
		});
	});

	test("answers 409 when the configured state is not one of the type's states", async () => {
		const { ado, call } = harness({}, { ADO_DONE_STATE: "Done" });
		const response = await call("POST", "/issues/96379/close");
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
			'"Done"',
		);
		expect(ado.items.get(96379)?.state).toBe("New");
	});

	test("answers a missing id with the reserved code", async () => {
		const { call } = harness();
		const response = await call("POST", "/issues/404404/close");
		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "issue_not_found" },
		});
	});
});

describe("upstream failures", () => {
	test("reports a rejected Azure DevOps credential as 502, never 401", async () => {
		const { call } = harness({ failWith: { status: 401 } });
		const response = await call("GET", "/issues/96379");
		expect(response.status).toBe(502);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "upstream_unauthorized" },
		});
	});

	test("treats the 203 sign-in page Azure DevOps serves for a bad token as a credential failure", async () => {
		const { call } = harness({ failWith: { status: 203, html: true } });
		const response = await call("GET", "/issues/96379");
		expect(response.status).toBe(502);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "upstream_unauthorized" },
		});
	});

	test("passes an Azure DevOps rate limit through with its Retry-After", async () => {
		const { call } = harness({ failWith: { status: 429, retryAfter: "30" } });
		const response = await call("GET", "/issues/96379");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("30");
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "upstream_rate_limited" },
		});
	});

	test("reports an Azure DevOps 5xx as 502", async () => {
		const { call } = harness({ failWith: { status: 503 } });
		const response = await call("GET", "/issues/96379");
		expect(response.status).toBe(502);
		expect((await response.json()) as unknown).toMatchObject({ error: { code: "upstream_error" } });
	});
});

describe("the warren-facing bearer", () => {
	test("rejects a request without the configured token", async () => {
		const { call } = harness({}, { TRACKER_BEARER: "secret" });
		const response = await call("GET", "/capabilities");
		expect(response.status).toBe(401);
		expect((await response.json()) as unknown).toMatchObject({ error: { code: "unauthorized" } });
	});

	test("admits a request carrying it", async () => {
		const { call } = harness({}, { TRACKER_BEARER: "secret" });
		const response = await call("GET", "/capabilities", { authorization: "Bearer secret" });
		expect(response.status).toBe(200);
	});
});

describe("the undeclared surfaces", () => {
	test("answer 404 capability_not_supported instead of a bare no-route", async () => {
		const { call } = harness();
		for (const [method, path] of [
			["GET", "/plans"],
			["GET", "/plans/pl-1"],
			["POST", "/issues/96379/metadata"],
			["GET", "/scheduled-issues"],
		] as const) {
			const response = await call(method, path);
			expect(response.status, `${method} ${path}`).toBe(404);
			expect((await response.json()) as unknown, `${method} ${path}`).toMatchObject({
				error: { code: "capability_not_supported" },
			});
		}
	});

	test("answers an unknown route with a plain not_found", async () => {
		const { call } = harness();
		const response = await call("GET", "/nope");
		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({ error: { code: "not_found" } });
	});
});

describe("a malformed path segment", () => {
	test("leaves through the error envelope instead of a URIError", async () => {
		const { call } = harness();
		for (const [method, path] of [
			["GET", "/issues/%"],
			["GET", "/issues/%zz"],
			["POST", "/issues/%/close"],
			["POST", "/issues/%e0%a4%a/close"],
		] as const) {
			const response = await call(method, path);
			expect(response.status, `${method} ${path}`).toBe(400);
			expect(response.headers.get("content-type"), `${method} ${path}`).toContain(
				"application/json",
			);
			expect((await response.json()) as unknown, `${method} ${path}`).toMatchObject({
				error: { code: "invalid_issue_id" },
			});
		}
	});

	test("still decodes a well-formed escape", async () => {
		const { call } = harness();
		const response = await call("GET", `/issues/${encodeURIComponent("96379")}`);
		expect(response.status).toBe(200);
	});
});
