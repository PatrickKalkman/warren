#!/usr/bin/env bun
/**
 * Pack-and-assert smoke gate for the shipped UI (warren-402e, plan pl-26f3
 * step 1, plan risk 5).
 *
 * `npm pack` is the truth of what `npm publish` ships. This guard packs the
 * tarball (dry-run — nothing is written) and asserts the built UI rides
 * along: `src/ui/dist/index.html` plus at least one JS and one CSS asset.
 * A publish that skipped `bun run build:ui`, or whose `files`/ignore rules
 * silently dropped the dist tree, fails here instead of shipping an
 * API-only package.
 *
 * Usage:
 *   bun run scripts/check-package-ui.ts
 *
 * Wired into `.github/workflows/release.yml`'s publish job after
 * `bun run build:ui` and before `npm publish`. The pure core
 * `uiPackProblems()` is unit-tested in `check-package-ui.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Pure assertion core over a pack file list. Returns an empty array when the
 * listing ships a servable UI, otherwise one human-readable problem per miss.
 */
export function uiPackProblems(paths: readonly string[]): string[] {
	const problems: string[] = [];
	const distFiles = paths.filter((p) => p.startsWith("src/ui/dist/"));
	if (distFiles.length === 0) {
		return [
			"npm pack contains no src/ui/dist/ files — the built UI is missing from the tarball. Run `bun run build:ui` before packing.",
		];
	}
	if (!distFiles.includes("src/ui/dist/index.html")) {
		problems.push("src/ui/dist/index.html is missing from the pack listing.");
	}
	if (!distFiles.some((p) => p.startsWith("src/ui/dist/assets/") && p.endsWith(".js"))) {
		problems.push(
			"no src/ui/dist/assets/*.js bundle in the pack listing — the UI would boot empty.",
		);
	}
	if (!distFiles.some((p) => p.startsWith("src/ui/dist/assets/") && p.endsWith(".css"))) {
		problems.push("no src/ui/dist/assets/*.css bundle in the pack listing.");
	}
	return problems;
}

/** Parses `npm pack --dry-run --json` stdout into a flat file-path list. */
export function packListingPaths(json: string): string[] {
	const parsed = JSON.parse(json) as unknown;
	const first = Array.isArray(parsed) ? parsed[0] : undefined;
	if (first === undefined || typeof first !== "object") return [];
	const files = (first as { files?: unknown }).files;
	if (!Array.isArray(files)) return [];
	return files.flatMap((f) => {
		// npm emits { path, size, mode } objects; fall back to bare strings.
		if (typeof f === "string") return [f];
		if (f !== null && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
			return [(f as { path: string }).path];
		}
		return [];
	});
}

function main(): number {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		console.error(`check-package-ui: npm pack failed (exit ${result.status})`);
		console.error(result.stderr);
		return 1;
	}
	const paths = packListingPaths(result.stdout);
	const problems = uiPackProblems(paths);
	if (problems.length > 0) {
		for (const problem of problems) {
			console.error(`check-package-ui: FAIL — ${problem}`);
		}
		console.error("check-package-ui: the release must not publish without the built UI.");
		return 1;
	}
	const distCount = paths.filter((p) => p.startsWith("src/ui/dist/")).length;
	console.log(`check-package-ui: OK — ${distCount} UI dist files in the pack listing.`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
