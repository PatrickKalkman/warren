import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-8b5f: the release job must be at least as strict as CI,
// must refuse to publish a release with no curated CHANGELOG section, and must
// keep a heartbeat on the auto-merge app credential — the credential whose
// silent death stops merges to main and therefore stops releases, with no
// failed run to notice.
//
// Workflows can't run locally, so these assert on the parsed YAML plus direct
// execution of the shell the workflow embeds.

const REPO_ROOT = resolve(import.meta.dir, "..");

type Step = {
	name?: string;
	id?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	uses?: string;
	with?: Record<string, string>;
};

type Job = { needs?: unknown; steps?: Step[] };

type Workflow = { jobs?: Record<string, Job> };

function loadRelease(): Workflow {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
	return load(raw) as Workflow;
}

function releaseSteps(job: string): Step[] {
	return loadRelease().jobs?.[job]?.steps ?? [];
}

/** The `run` script of the first step in `job` whose name starts with `prefix`. */
function stepScript(job: string, prefix: string): string {
	const step = releaseSteps(job).find((s) => s.name?.startsWith(prefix));
	if (step?.run === undefined) throw new Error(`no step "${prefix}" with a run script`);
	return step.run;
}

/** Bare `- run: X` steps (no name), as their command strings. */
function bareRunCommands(job: string): string[] {
	return releaseSteps(job)
		.filter((s) => s.name === undefined && typeof s.run === "string")
		.map((s) => (s.run ?? "").trim());
}

describe("release runs the real gate suite", () => {
	test("the release job runs check:all, not a hand-picked subset", () => {
		const commands = bareRunCommands("release");
		expect(commands).toContain("bun run check:all");
		// knip (check:deps) resolves the src/ui workspace and runs before
		// check:bundle-size builds it, so the UI deps must land first.
		expect(commands).toContain("bun run ui:install");
		expect(commands.indexOf("bun run ui:install")).toBeLessThan(
			commands.indexOf("bun run check:all"),
		);
	});

	test("the superseded four-gate subset is gone", () => {
		const commands = bareRunCommands("release");
		// These are all inside check:all now; listing them separately is what
		// let the manifest and the release drift apart in the first place.
		for (const stale of ["bun run lint", "bun run typecheck", "bun test"]) {
			expect(commands).not.toContain(stale);
		}
	});
});

/**
 * Execute the workflow's embedded changelog-extraction shell against a scratch
 * CHANGELOG.md, so the assertions exercise what the workflow really runs.
 */
function extractNotes(
	version: string,
	changelog: string,
): { exitCode: number; output: string; notes: string | null } {
	const script = stepScript("release", "Extract changelog notes");
	const dir = mkdtempSync(join(tmpdir(), "warren-changelog-"));
	try {
		writeFileSync(join(dir, "CHANGELOG.md"), changelog);
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			cwd: dir,
			env: { PATH: process.env.PATH ?? "", VERSION: version, RUNNER_TEMP: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		let notes: string | null = null;
		try {
			notes = readFileSync(join(dir, "release-notes.md"), "utf8");
		} catch {
			notes = null;
		}
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
			notes,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const CHANGELOG = `# Changelog

## [0.11.0] - 2026-07-27

### Added
- A thing.

## [0.10.0] - 2026-07-01

### Added
- An older thing.
`;

describe("a missing CHANGELOG section is fatal", () => {
	test("a present section is written out as the release notes", () => {
		const r = extractNotes("0.11.0", CHANGELOG);
		expect(r.exitCode).toBe(0);
		expect(r.notes).toContain("A thing.");
		// The next version's section must not bleed in.
		expect(r.notes).not.toContain("An older thing.");
	});

	test("an absent section fails the release instead of auto-generating notes", () => {
		const r = extractNotes("0.12.0", CHANGELOG);
		expect(r.exitCode).toBe(1);
		expect(r.output).toContain("::error::");
		expect(r.output).toContain("no '## [0.12.0]' section");
	});

	test("a present but empty section is treated as absent", () => {
		const r = extractNotes(
			"0.11.0",
			"# Changelog\n\n## [0.11.0] - 2026-07-27\n\n## [0.10.0]\n- x\n",
		);
		expect(r.exitCode).toBe(1);
	});

	test("the release step has no --generate-notes fallback left", () => {
		expect(stepScript("release", "Create GitHub release")).not.toContain("--generate-notes");
	});
});

// The merge queue authenticates with a GitHub App installation token minted
// per run (warren-2565 retired the static AUTO_MERGE_PAT after it expired
// silently). App private keys carry no expiry, so the heartbeat is a mint
// attempt: if the credential is dead, the mint step fails and the sibling
// job goes red without blocking the release.
describe("auto-merge app credential heartbeat", () => {
	test("runs as a sibling job so a dead credential is visible but never blocks a release", () => {
		const job = loadRelease().jobs?.["app-heartbeat"];
		expect(job).toBeDefined();
		// No `needs` edge in either direction: the release itself is cut with
		// github.token and is unaffected by the app credential.
		expect(job?.needs).toBeUndefined();
		expect(loadRelease().jobs?.deploy?.needs).toBe("release");
	});

	test("the heartbeat mints a token from the app id and private key", () => {
		const steps = releaseSteps("app-heartbeat");
		const mint = steps.find((s) => s.uses?.startsWith("actions/create-github-app-token@"));
		expect(mint).toBeDefined();
		expect(mint?.with?.["app-id"]).toMatch(/^\$\{\{ vars\.AUTO_MERGE_APP_ID \}\}$/);
		expect(mint?.with?.["private-key"]).toMatch(
			/^\$\{\{ secrets\.AUTO_MERGE_APP_PRIVATE_KEY \}\}$/,
		);
	});

	test("no workflow still authenticates with the retired AUTO_MERGE_PAT", () => {
		for (const file of ["auto-merge.yml", "bundle-size-autoheal.yml", "release.yml"]) {
			const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8");
			expect(raw).not.toContain("secrets.AUTO_MERGE_PAT");
		}
	});

	test("every consumer of the app credential names the same variable and secret", () => {
		for (const file of ["auto-merge.yml", "bundle-size-autoheal.yml", "release.yml"]) {
			const raw = readFileSync(resolve(REPO_ROOT, ".github/workflows", file), "utf8");
			expect(raw).toContain("vars.AUTO_MERGE_APP_ID");
			expect(raw).toContain("secrets.AUTO_MERGE_APP_PRIVATE_KEY");
		}
	});
});

// A failed release chain leaves a draft release behind a pushed tag. Before
// warren-a8e6 that state was unrecoverable with a workflow fix: `gh run rerun`
// replays the OLD workflow commit, and a fresh workflow_dispatch saw the tag
// and skipped the whole chain. The version-check step now treats an existing
// DRAFT as resumable and emits the peeled tag commit as `release_sha`, so
// deploy/publish build the exact commit the tag names even though main has
// moved on. A FINAL release still short-circuits.
type VersionCheck = { exitCode: number; output: string; outputs: Record<string, string> };

function runVersionCheck(opts: {
	tagExists: boolean;
	draft?: boolean;
	tagSha?: string;
	githubSha: string;
}): VersionCheck {
	const script = stepScript("release", "Check if version is unreleased");
	const dir = mkdtempSync(join(tmpdir(), "warren-version-check-"));
	try {
		const bin = join(dir, "bin");
		Bun.spawnSync({ cmd: ["mkdir", "-p", bin] });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
		const stub = (name: string, body: string) => {
			const path = join(bin, name);
			writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
			Bun.spawnSync({ cmd: ["chmod", "+x", path] });
		};
		stub("node", `[ "$1" = "-p" ] || exit 99\necho 9.9.9`);
		stub(
			"git",
			[
				`case "$1" in`,
				`  ls-remote) ${opts.tagExists ? "exit 0" : "exit 2"} ;;`,
				`  rev-list) echo "${opts.tagSha ?? ""}" ;;`,
				`  *) exit 99 ;;`,
				`esac`,
			].join("\n"),
		);
		stub("gh", opts.draft === undefined ? `exit 1` : `echo ${opts.draft ? "true" : "false"}`);
		const out = join(dir, "github-output");
		writeFileSync(out, "");
		const result = Bun.spawnSync({
			cmd: ["bash", "-c", script],
			cwd: dir,
			env: {
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				GITHUB_OUTPUT: out,
				GITHUB_SHA: opts.githubSha,
				GH_TOKEN: "stub",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const outputs: Record<string, string> = {};
		for (const line of readFileSync(out, "utf8").split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
		}
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
			outputs,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("a failed release resumes from its draft at the tagged commit", () => {
	test("an unreleased version releases at the pushed commit", () => {
		const r = runVersionCheck({ tagExists: false, githubSha: "aaa111" });
		expect(r.exitCode).toBe(0);
		expect(r.outputs).toEqual({ release: "true", version: "9.9.9", release_sha: "aaa111" });
	});

	test("a tag with a draft release resumes at the tag's commit, not current main", () => {
		const r = runVersionCheck({
			tagExists: true,
			draft: true,
			tagSha: "tag000",
			githubSha: "main999",
		});
		expect(r.exitCode).toBe(0);
		expect(r.outputs).toEqual({ release: "true", version: "9.9.9", release_sha: "tag000" });
		expect(r.output).toContain("Resuming draft v9.9.9 at tag000");
	});

	test("a tag with a final release is skipped", () => {
		const r = runVersionCheck({ tagExists: true, draft: false, githubSha: "main999" });
		expect(r.exitCode).toBe(0);
		expect(r.outputs).toEqual({ release: "false" });
	});

	test("a tag whose release lookup fails is treated as final, never re-released", () => {
		// gh exits non-zero (no release object at all): the conservative arm wins.
		const r = runVersionCheck({ tagExists: true, githubSha: "main999" });
		expect(r.exitCode).toBe(0);
		expect(r.outputs).toEqual({ release: "false" });
	});

	test("the release job exports release_sha and deploy + publish consume it", () => {
		// Assembled at runtime so Biome's noTemplateCurlyInString stays quiet.
		const stepExpr = `\${{ steps.version-check.outputs.release_sha }}`;
		const needsExpr = `\${{ needs.release.outputs.release_sha }}`;
		const wf = loadRelease() as Workflow & {
			jobs?: Record<
				string,
				Job & { outputs?: Record<string, string>; with?: Record<string, string> }
			>;
		};
		expect(wf.jobs?.release?.outputs?.release_sha).toBe(stepExpr);
		expect(wf.jobs?.deploy?.with?.sha).toBe(needsExpr);
		const checkout = releaseSteps("publish").find((s) => s.uses?.startsWith("actions/checkout"));
		expect(checkout?.with?.ref).toBe(needsExpr);
	});
});
