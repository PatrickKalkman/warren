import { describe, expect, test } from "bun:test";
import { adoRepoLayout, parseAdoCoordinate, parseAdoRepoRef, unpackAdoRef } from "./repo-ref.ts";

const KEY = "dev.azure.com/acme/Widgets/widget";

describe("parseAdoRepoRef", () => {
	test("packs the org/project/repo triple into the key for every accepted grammar", () => {
		const urls = [
			"https://dev.azure.com/acme/Widgets/_git/widget",
			"https://dev.azure.com/acme/Widgets/_git/widget.git",
			"https://dev.azure.com/acme/Widgets/_git/widget/",
			"https://acme@dev.azure.com/acme/Widgets/_git/widget",
			"git@ssh.dev.azure.com:v3/acme/Widgets/widget",
			"https://acme.visualstudio.com/Widgets/_git/widget",
			"https://acme.visualstudio.com/DefaultCollection/Widgets/_git/widget",
			"https://dev.azure.com/acme/Widgets/_git/widget/pullrequest/12",
			"  https://dev.azure.com/acme/Widgets/_git/widget  ",
		];
		for (const url of urls) {
			expect(parseAdoRepoRef(url)).toEqual({ forge: "ado", key: KEY });
		}
	});

	test("keeps a project name with spaces, URL-encoded in the key", () => {
		const ref = parseAdoRepoRef("https://dev.azure.com/acme/My%20Project/_git/widget");
		expect(ref?.key).toBe("dev.azure.com/acme/My%20Project/widget");
		if (ref === null) throw new Error("unreachable");
		expect(unpackAdoRef(ref)).toEqual({ org: "acme", project: "My Project", repo: "widget" });
	});

	test("returns null for foreign hosts and malformed paths", () => {
		const foreign = [
			"https://github.com/o/r.git",
			"git@github.com:o/r.git",
			"fake://projects/widget",
			"https://dev.azure.com/acme/Widgets/widget",
			"https://dev.azure.com/acme/Widgets/_git",
			"https://dev.azure.com/acme/Widgets/_git/widget/extra",
			"https://dev.azure.com/acme/Widgets/_git/widget/pullrequest/x",
			"ftp://dev.azure.com/acme/Widgets/_git/widget",
			"not a url",
			"",
		];
		for (const url of foreign) {
			expect(parseAdoRepoRef(url)).toBeNull();
		}
	});

	test("rejects path-unsafe org and repo segments", () => {
		expect(parseAdoRepoRef("https://dev.azure.com/../Widgets/_git/widget")).toBeNull();
		expect(parseAdoRepoRef("https://dev.azure.com/acme/Widgets/_git/-widget")).toBeNull();
		expect(parseAdoRepoRef("https://dev.azure.com/acme/Widgets/_git/wid%20get")).toBeNull();
		expect(parseAdoCoordinate("https://dev.azure.com/acme/../_git/widget")).toBeNull();
	});
});

describe("adoRepoLayout", () => {
	test("folds org and project into the owner segment", () => {
		expect(adoRepoLayout("https://dev.azure.com/acme/Widgets/_git/widget")).toEqual({
			owner: "acme-Widgets",
			name: "widget",
		});
	});

	test("turns spaces in the project name into dashes", () => {
		expect(adoRepoLayout("https://dev.azure.com/acme/My%20Project/_git/widget")).toEqual({
			owner: "acme-My-Project",
			name: "widget",
		});
	});

	test("returns null for a foreign URL or an unsafe layout", () => {
		expect(adoRepoLayout("https://github.com/o/r.git")).toBeNull();
		expect(adoRepoLayout("https://dev.azure.com/acme/Proj%2Fect/_git/widget")).toBeNull();
	});
});
