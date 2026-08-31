/**
 * Jira payloads to warren-tracker/v1 shapes. Pure, and defensive about
 * every field: these values crossed an HTTP boundary.
 *
 * The one rule worth stating twice is the status rule. `status` on the
 * wire is warren's `open | closed | other`, never Jira's status name.
 * A workflow names its statuses however it likes ("In Progress", "Done",
 * "Won't Do"), and warren's bridge rejects every string it does not
 * know, so the fold has to happen here, where the status category is
 * known: `new` is open, `done` is closed, and `indeterminate` is neither.
 */

import type { IssueStatus, RemoteIssueResponse } from "../protocol.ts";
import {
	JIRA_DONE_CATEGORY,
	JIRA_NEW_CATEGORY,
	type JiraIssue,
	type JiraIssueLink,
	type JiraTransition,
} from "./types.ts";

/**
 * Flatten an Atlassian Document Format tree to text. v3 returns
 * `description` as a node tree; v2 and some proxies return a plain
 * string, so a string passes through untouched.
 *
 * Block-level nodes separate with a blank line and inline nodes join
 * directly, which is enough to keep a paragraph readable in a prompt.
 * A hard break is a newline. Anything unrecognized contributes its
 * children, so an unknown node type loses its formatting rather than its
 * text.
 */
export function flattenAdf(description: unknown): string | undefined {
	if (typeof description === "string") {
		return description.length > 0 ? description : undefined;
	}
	if (description === null || typeof description !== "object") return undefined;
	const text = renderNode(description as AdfNode).trim();
	return text.length > 0 ? text : undefined;
}

interface AdfNode {
	readonly type?: string;
	readonly text?: string;
	readonly content?: readonly unknown[];
}

const BLOCK_TYPES = new Set([
	"paragraph",
	"heading",
	"blockquote",
	"codeBlock",
	"listItem",
	"panel",
	"rule",
	"mediaSingle",
	"table",
	"tableRow",
]);

function renderNode(node: AdfNode): string {
	if (typeof node.text === "string") return node.text;
	if (node.type === "hardBreak") return "\n";
	const children = Array.isArray(node.content) ? node.content : [];
	const parts: string[] = [];
	for (const child of children) {
		if (child === null || typeof child !== "object") continue;
		parts.push(renderNode(child as AdfNode));
	}
	const joined = parts.join("");
	return BLOCK_TYPES.has(node.type ?? "") ? `${joined}\n\n` : joined;
}

/**
 * The keys of the issues that block this one. Jira models the
 * relationship on the link type's INWARD side, so an issue that is
 * blocked carries a link whose `type.inward` reads "is blocked by" and
 * whose `inwardIssue` is the blocker. The description is workflow text a
 * Jira admin can rename, which is why it is configurable.
 */
export function blockedByKeys(
	links: readonly JiraIssueLink[] | undefined,
	inwardDescription: string,
): string[] {
	if (links === undefined) return [];
	const wanted = inwardDescription.trim().toLowerCase();
	const keys: string[] = [];
	for (const link of links) {
		const inward = link.type?.inward?.trim().toLowerCase();
		const key = link.inwardIssue?.key;
		if (inward === wanted && typeof key === "string" && key.length > 0) keys.push(key);
	}
	return keys;
}

/** True when Jira considers the issue terminal, whatever the status is called. */
export function isDone(issue: JiraIssue): boolean {
	return issue.fields?.status?.statusCategory?.key === JIRA_DONE_CATEGORY;
}

/**
 * The issue's status on warren's vocabulary, by Jira's status category
 * rather than the status name: `new` is the only category warren may
 * claim from, `done` is finished, and `indeterminate` is in flight.
 * An issue whose workflow reports no category is `other` as well: it
 * cannot be shown closed, and claiming it would be a guess.
 */
export function issueStatus(issue: JiraIssue): IssueStatus {
	const category = issue.fields?.status?.statusCategory?.key;
	if (category === JIRA_DONE_CATEGORY) return "closed";
	if (category === JIRA_NEW_CATEGORY) return "open";
	return "other";
}

export function toIssueResponse(
	issue: JiraIssue,
	fallbackKey: string,
	inwardDescription: string,
): RemoteIssueResponse {
	const title = issue.fields?.summary ?? undefined;
	const description = flattenAdf(issue.fields?.description);
	const blockedBy = blockedByKeys(issue.fields?.issuelinks, inwardDescription);
	return {
		id: issue.key ?? fallbackKey,
		status: issueStatus(issue),
		...(typeof title === "string" && title.length > 0 ? { title } : {}),
		...(description !== undefined ? { description } : {}),
		...(blockedBy.length > 0 ? { blockedBy } : {}),
	};
}

/**
 * The transition that closes the issue. A configured name wins and is
 * matched case-insensitively, because an operator who named one means
 * that one. Otherwise the first transition landing in the `done` category
 * is the answer, which is how Jira itself defines terminal.
 *
 * Returns undefined when the workflow offers no way out from here. That
 * is a real configuration answer, not a transient failure, so the caller
 * must not retry it.
 */
export function pickCloseTransition(
	transitions: readonly JiraTransition[] | undefined,
	configuredName: string | undefined,
): JiraTransition | undefined {
	const available = (transitions ?? []).filter((t) => typeof t.id === "string" && t.id.length > 0);
	if (configuredName !== undefined) {
		const wanted = configuredName.trim().toLowerCase();
		return available.find((t) => t.name?.trim().toLowerCase() === wanted);
	}
	return available.find((t) => t.to?.statusCategory?.key === JIRA_DONE_CATEGORY);
}
