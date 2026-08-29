/**
 * `parseRepoRef` support for Azure DevOps Repos — the clone-URL grammars
 * the arm owns and the packed `RepoRef.key` shape.
 *
 * An Azure DevOps repository is a three-part coordinate: organization,
 * project, repository. The contract's `RepoRef` stays two fields
 * (forge-contract.md §2): the triple packs into `key` as
 * `dev.azure.com/<org>/<project>/<repo>` and only this arm unpacks it.
 *
 * Accepted grammars:
 *   - `https://dev.azure.com/<org>/<project>/_git/<repo>`
 *   - `https://<org>@dev.azure.com/<org>/<project>/_git/<repo>` (the
 *     clone URL the Azure DevOps UI hands out)
 *   - `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`
 *   - `https://<org>.visualstudio.com/<project>/_git/<repo>` (legacy host)
 *   - `https://<org>.visualstudio.com/DefaultCollection/<project>/_git/<repo>`
 *   - the pull-request web URL of any of the above: `.../_git/<repo>/pullrequest/<n>`
 *
 * Everything here NEVER throws — a URL this forge does not own returns
 * `null` so the registry can try the next forge (§1.1).
 */

import type { RepoRef } from "../contract.ts";

/** Registry key this forge answers to (`FORGE_KINDS`). */
export const ADO_FORGE_KIND = "ado";

/** Host every packed key and API call is anchored on. */
export const ADO_HOST = "dev.azure.com";

const KEY_PREFIX = `${ADO_HOST}/`;

/** The unpacked three-part coordinate — provider-private. */
export interface AdoCoordinate {
	readonly org: string;
	readonly project: string;
	readonly repo: string;
}

/**
 * Path-safety rule for the organization and repository segments, the same
 * character set `src/projects/url.ts` guards `/data/projects` with.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Project names are looser than repository names: Azure DevOps allows
 * spaces and a few punctuation marks. The project only ever travels
 * URL-encoded in API paths, so it is held to "printable, no slash".
 */
const PROJECT_SEGMENT = /^[^/\\\s][^/\\]*$/;

function isSafeSegment(segment: string): boolean {
	return (
		SAFE_SEGMENT.test(segment) && segment !== "." && segment !== ".." && !segment.startsWith("-")
	);
}

/** Parse a clone or pull-request URL into this forge's opaque ref. */
export function parseAdoRepoRef(cloneUrl: string): RepoRef | null {
	const coordinate = parseAdoCoordinate(cloneUrl);
	if (coordinate === null) return null;
	return { forge: ADO_FORGE_KIND, key: packKey(coordinate) };
}

/** Unpack a key this arm produced. Only the provider calls this. */
export function unpackAdoRef(ref: RepoRef): AdoCoordinate {
	const [org = "", project = "", repo = ""] = ref.key.slice(KEY_PREFIX.length).split("/");
	return { org, project: decodeURIComponent(project), repo };
}

function packKey(c: AdoCoordinate): string {
	return `${KEY_PREFIX}${c.org}/${encodeURIComponent(c.project)}/${c.repo}`;
}

/**
 * The on-disk layout for `/data/projects/<owner>/<name>` (`Forge.repoLayout`).
 * The organization and project fold into one owner segment so two
 * repositories with the same name in different projects never collide.
 * Spaces in a project name become dashes, the only transformation needed
 * to keep the segment path-safe.
 */
export function adoRepoLayout(cloneUrl: string): { owner: string; name: string } | null {
	const coordinate = parseAdoCoordinate(cloneUrl);
	if (coordinate === null) return null;
	const owner = `${coordinate.org}-${coordinate.project.replace(/\s+/g, "-")}`;
	if (!isSafeSegment(owner)) return null;
	return { owner, name: coordinate.repo };
}

/** Extract the coordinate from any accepted grammar; `null` when foreign. */
export function parseAdoCoordinate(input: string): AdoCoordinate | null {
	const trimmed = input.trim();
	const scp = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/.exec(trimmed);
	if (scp !== null) {
		return finish(scp[1] as string, decodeURIComponent(scp[2] as string), scp[3] as string);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const host = parsed.hostname.toLowerCase();
	const parts = parsed.pathname
		.split("/")
		.filter((p) => p !== "")
		.map((p) => decodeURIComponent(p));

	if (host === ADO_HOST) return fromParts(parts[0], parts.slice(1));
	const legacy = /^([a-z0-9-]+)\.visualstudio\.com$/.exec(host);
	if (legacy !== null) {
		const rest = parts[0]?.toLowerCase() === "defaultcollection" ? parts.slice(1) : parts;
		return fromParts(legacy[1], rest);
	}
	return null;
}

/**
 * `rest` is `[<project>, "_git", <repo>]`, optionally followed by
 * `["pullrequest", <n>]` for a PR web URL.
 */
function fromParts(org: string | undefined, rest: string[]): AdoCoordinate | null {
	if (org === undefined) return null;
	const [project, marker, repoRaw, tail, tailArg] = rest;
	if (project === undefined || marker !== "_git" || repoRaw === undefined) return null;
	if (rest.length === 5) {
		if (tail !== "pullrequest" || !/^\d+$/.test(tailArg ?? "")) return null;
	} else if (rest.length !== 3) {
		return null;
	}
	return finish(org, project, stripGitSuffix(repoRaw));
}

function stripGitSuffix(segment: string): string {
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

function finish(org: string, project: string, repo: string): AdoCoordinate | null {
	if (!isSafeSegment(org) || !isSafeSegment(repo)) return null;
	if (!PROJECT_SEGMENT.test(project) || project === "." || project === "..") return null;
	return { org, project, repo };
}
