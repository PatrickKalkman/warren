import { describe, expect, test } from "bun:test";
import { adoAuthHeader, ConfigError, loadConfig } from "./config.ts";

const base = {
	ADO_ORG_URL: "https://dev.azure.com/acme",
	ADO_PROJECT: "Platform",
	ADO_PAT: "pat-123",
	ADO_WIQL: "SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'warren'",
};

describe("loadConfig", () => {
	test("reads the minimum an Azure DevOps project needs", () => {
		const config = loadConfig(base);
		expect(config.orgUrl).toBe("https://dev.azure.com/acme");
		expect(config.project).toBe("Platform");
		expect(config.auth).toEqual({ kind: "pat", token: "pat-123" });
		expect(config.wiql).toBe(base.ADO_WIQL);
		expect(config.port).toBe(8080);
		expect(config.blockedByLink).toBe("System.LinkTypes.Dependency-Reverse");
		expect(config.batchSize).toBe(200);
		expect(config.maxWiqlResults).toBe(5000);
		expect(config.bearerToken).toBeUndefined();
		expect(config.doneState).toBeUndefined();
	});

	test("trims the trailing slash off the organization url", () => {
		expect(loadConfig({ ...base, ADO_ORG_URL: "https://dev.azure.com/acme//" }).orgUrl).toBe(
			"https://dev.azure.com/acme",
		);
	});

	test("names the variable that is missing", () => {
		expect(() => loadConfig({ ...base, ADO_WIQL: undefined })).toThrow(/ADO_WIQL is required/);
		expect(() => loadConfig({ ...base, ADO_PROJECT: " " })).toThrow(/ADO_PROJECT is required/);
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "" })).toThrow(/ADO_ORG_URL is required/);
	});

	test("refuses an organization url that is not http", () => {
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "dev.azure.com/acme" })).toThrow(ConfigError);
	});

	test("takes ADO_BEARER instead of a personal access token", () => {
		const config = loadConfig({ ...base, ADO_PAT: undefined, ADO_BEARER: "entra-abc" });
		expect(config.auth).toEqual({ kind: "bearer", token: "entra-abc" });
	});

	test("refuses both auth modes at once rather than picking one", () => {
		expect(() => loadConfig({ ...base, ADO_BEARER: "entra-abc" })).toThrow(/not both/);
	});

	test("refuses a missing credential and names both options", () => {
		expect(() => loadConfig({ ...base, ADO_PAT: undefined })).toThrow(/ADO_PAT.*ADO_BEARER/);
	});

	test("refuses a port that is not a positive whole number", () => {
		expect(() => loadConfig({ ...base, TRACKER_PORT: "0" })).toThrow(/positive whole number/);
		expect(() => loadConfig({ ...base, TRACKER_PORT: "http" })).toThrow(/positive whole number/);
		expect(loadConfig({ ...base, TRACKER_PORT: "9000" }).port).toBe(9000);
	});

	test("refuses a batch size past the Azure DevOps limit", () => {
		expect(() => loadConfig({ ...base, ADO_BATCH_SIZE: "201" })).toThrow(/at most 200/);
		expect(loadConfig({ ...base, ADO_BATCH_SIZE: "50" }).batchSize).toBe(50);
	});

	test("carries the close state and the link type when configured", () => {
		const config = loadConfig({
			...base,
			ADO_DONE_STATE: "Resolved",
			ADO_BLOCKED_BY_LINK: "System.LinkTypes.Related",
		});
		expect(config.doneState).toBe("Resolved");
		expect(config.blockedByLink).toBe("System.LinkTypes.Related");
	});

	test("carries the warren-facing bearer separately from the Azure DevOps credential", () => {
		const config = loadConfig({ ...base, TRACKER_BEARER: "warren-side" });
		expect(config.bearerToken).toBe("warren-side");
		expect(config.auth).toEqual({ kind: "pat", token: "pat-123" });
	});
});

describe("adoAuthHeader", () => {
	test("base64-encodes an empty user name and the token for a personal access token", () => {
		const header = adoAuthHeader({ kind: "pat", token: "t" });
		expect(header).toBe(`Basic ${Buffer.from(":t").toString("base64")}`);
	});

	test("passes a bearer token through", () => {
		expect(adoAuthHeader({ kind: "bearer", token: "abc" })).toBe("Bearer abc");
	});
});
