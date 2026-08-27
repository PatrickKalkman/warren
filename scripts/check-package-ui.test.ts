import { describe, expect, test } from "bun:test";
import { packListingPaths, uiPackProblems } from "./check-package-ui.ts";

describe("uiPackProblems", () => {
	test("accepts a listing that ships the built UI", () => {
		const problems = uiPackProblems([
			"package.json",
			"src/server/main/index.ts",
			"src/ui/dist/index.html",
			"src/ui/dist/favicon.svg",
			"src/ui/dist/assets/index-abc123.js",
			"src/ui/dist/assets/index-abc123.css",
		]);
		expect(problems).toEqual([]);
	});

	test("reports a single problem when dist is entirely absent", () => {
		const problems = uiPackProblems(["package.json", "src/server/main/index.ts"]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("built UI is missing");
	});

	test("reports a missing index.html separately from missing bundles", () => {
		const problems = uiPackProblems([
			"src/ui/dist/assets/only-fonts.woff2",
			"src/ui/dist/assets/index-abc123.js",
		]);
		expect(problems).toEqual([
			"src/ui/dist/index.html is missing from the pack listing.",
			"no src/ui/dist/assets/*.css bundle in the pack listing.",
		]);
	});

	test("reports missing JS and CSS bundles", () => {
		const problems = uiPackProblems(["src/ui/dist/index.html"]);
		expect(problems).toEqual([
			"no src/ui/dist/assets/*.js bundle in the pack listing — the UI would boot empty.",
			"no src/ui/dist/assets/*.css bundle in the pack listing.",
		]);
	});

	test("ignores UI sources outside dist", () => {
		const problems = uiPackProblems([
			"src/ui/dist/index.html",
			"src/ui/dist/assets/a.js",
			"src/ui/dist/assets/a.css",
			"src/ui/package.json",
		]);
		expect(problems).toEqual([]);
	});
});

describe("packListingPaths", () => {
	test("flattens npm pack --json output (path objects)", () => {
		const json = JSON.stringify([
			{
				files: [
					{ path: "package.json", size: 1, mode: 420 },
					{ path: "src/ui/dist/index.html", size: 2, mode: 420 },
				],
			},
		]);
		expect(packListingPaths(json)).toEqual(["package.json", "src/ui/dist/index.html"]);
	});

	test("accepts bare string entries for older npm shapes", () => {
		const json = JSON.stringify([{ files: ["package.json", "src/index.ts"] }]);
		expect(packListingPaths(json)).toEqual(["package.json", "src/index.ts"]);
	});

	test("returns empty for malformed payload", () => {
		expect(packListingPaths("[]")).toEqual([]);
		expect(packListingPaths("null")).toEqual([]);
		expect(packListingPaths(JSON.stringify([{ files: "not-a-list" }]))).toEqual([]);
		expect(packListingPaths(JSON.stringify([{ files: [{ size: 1 }] }]))).toEqual([]);
	});
});
