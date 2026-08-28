import { describe, expect, test } from "bun:test";
import {
	blockedByIds,
	describeWorkItem,
	htmlToText,
	isTerminal,
	parseWorkItemId,
	pickCloseState,
	toIssueResponse,
	workItemIdFromUrl,
} from "./map.ts";
import type { AdoWorkItemTypeState } from "./types.ts";

const LINK = "System.LinkTypes.Dependency-Reverse";

const AGILE: readonly AdoWorkItemTypeState[] = [
	{ name: "New", category: "Proposed" },
	{ name: "Active", category: "InProgress" },
	{ name: "Resolved", category: "Resolved" },
	{ name: "Closed", category: "Completed" },
	{ name: "Removed", category: "Removed" },
];

describe("parseWorkItemId", () => {
	test("accepts a decimal work item number", () => {
		expect(parseWorkItemId("96379")).toBe(96379);
	});

	test("rejects anything that names no work item", () => {
		for (const raw of ["", "0", "-1", "abc", "1.5", "007", "1e3", " 12"]) {
			expect(parseWorkItemId(raw), raw).toBeUndefined();
		}
	});
});

describe("htmlToText", () => {
	test("turns block ends into newlines and drops every other tag", () => {
		expect(htmlToText("<div>One</div><div>Two <b>bold</b></div>")).toBe("One\nTwo bold");
	});

	test("honors line breaks and collapses runs of blank lines", () => {
		expect(htmlToText("<p>A</p><p><br></p><p><br/></p><p>B</p>")).toBe("A\n\nB");
	});

	test("decodes the entities the editor emits", () => {
		expect(htmlToText("a&nbsp;&amp;&nbsp;b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;")).toBe(
			"a & b <c> \"d\" 'e' A",
		);
	});

	test("leaves an unknown entity alone rather than guessing", () => {
		expect(htmlToText("&bogus; &#xzz;")).toBe("&bogus; &#xzz;");
	});

	test("answers undefined for a missing or empty field", () => {
		expect(htmlToText(undefined)).toBeUndefined();
		expect(htmlToText(null)).toBeUndefined();
		expect(htmlToText("<div><br></div>")).toBeUndefined();
	});
});

describe("describeWorkItem", () => {
	test("labels the sections the process template splits the narrative across", () => {
		const text = describeWorkItem({
			fields: {
				"System.Description": "<div>Story</div>",
				"Microsoft.VSTS.TCM.ReproSteps": "<div>Steps</div>",
				"Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>One</li><li>Two</li></ul>",
			},
		});
		expect(text).toBe("Story\n\nRepro steps:\nSteps\n\nAcceptance criteria:\nOne\nTwo");
	});

	test("carries a bug's repro steps when it has no description", () => {
		expect(describeWorkItem({ fields: { "Microsoft.VSTS.TCM.ReproSteps": "Crash" } })).toBe(
			"Repro steps:\nCrash",
		);
	});

	test("answers undefined when every field is empty", () => {
		expect(describeWorkItem({ fields: { "System.Description": null } })).toBeUndefined();
		expect(describeWorkItem({})).toBeUndefined();
	});
});

describe("workItemIdFromUrl", () => {
	test("reads the id off the end of a work item url", () => {
		expect(workItemIdFromUrl("https://dev.azure.com/acme/_apis/wit/workItems/42")).toBe(42);
		expect(workItemIdFromUrl("https://dev.azure.com/acme/_apis/wit/workitems/42/")).toBe(42);
	});

	test("answers undefined for anything else", () => {
		expect(workItemIdFromUrl(undefined)).toBeUndefined();
		expect(workItemIdFromUrl("https://dev.azure.com/acme/_apis/wit/workItems/abc")).toBeUndefined();
		expect(
			workItemIdFromUrl("https://dev.azure.com/acme/_apis/git/repositories/1"),
		).toBeUndefined();
	});
});

describe("blockedByIds", () => {
	test("reads the predecessor side of a dependency link", () => {
		const ids = blockedByIds(
			[
				{ rel: LINK, url: "https://dev.azure.com/acme/_apis/wit/workItems/1" },
				{ rel: "System.LinkTypes.Dependency-Forward", url: "https://x/_apis/wit/workItems/2" },
				{ rel: "System.LinkTypes.Related", url: "https://x/_apis/wit/workItems/3" },
				{ rel: LINK },
				{ rel: LINK, url: "https://dev.azure.com/acme/_apis/wit/workItems/4" },
			],
			LINK,
		);
		expect(ids).toEqual(["1", "4"]);
	});

	test("matches the configured link type case-insensitively", () => {
		expect(
			blockedByIds([{ rel: LINK.toUpperCase(), url: "https://x/_apis/wit/workItems/9" }], LINK),
		).toEqual(["9"]);
	});

	test("answers an empty list without relations", () => {
		expect(blockedByIds(undefined, LINK)).toEqual([]);
	});
});

describe("isTerminal", () => {
	test("is true in the Completed and Removed categories", () => {
		expect(isTerminal({ fields: { "System.State": "Closed" } }, AGILE)).toBe(true);
		expect(isTerminal({ fields: { "System.State": "removed" } }, AGILE)).toBe(true);
	});

	test("is false elsewhere, and for a state the process does not define", () => {
		expect(isTerminal({ fields: { "System.State": "Resolved" } }, AGILE)).toBe(false);
		expect(isTerminal({ fields: { "System.State": "Mystery" } }, AGILE)).toBe(false);
		expect(isTerminal({}, AGILE)).toBe(false);
	});
});

describe("pickCloseState", () => {
	test("takes the first Completed-category state when none is configured", () => {
		expect(pickCloseState(AGILE, undefined)).toBe("Closed");
	});

	test("prefers the configured name, matched case-insensitively, in the process's spelling", () => {
		expect(pickCloseState(AGILE, "resolved")).toBe("Resolved");
	});

	test("answers undefined when the configured name is not a state of this type", () => {
		expect(pickCloseState(AGILE, "Done")).toBeUndefined();
	});

	test("answers undefined when the process has no Completed-category state", () => {
		expect(pickCloseState([{ name: "New", category: "Proposed" }], undefined)).toBeUndefined();
		expect(pickCloseState([], undefined)).toBeUndefined();
	});
});

describe("toIssueResponse", () => {
	test("maps every field and omits the empty ones", () => {
		expect(
			toIssueResponse(
				{
					id: 7,
					fields: {
						"System.Title": "Title",
						"System.State": "Active",
						"System.Description": "<p>Body</p>",
					},
					relations: [{ rel: LINK, url: "https://x/_apis/wit/workItems/3" }],
				},
				"7",
				LINK,
			),
		).toEqual({
			id: "7",
			status: "Active",
			title: "Title",
			description: "Body",
			blockedBy: ["3"],
		});
	});

	test("falls back to the requested id and an empty status on a bare payload", () => {
		expect(toIssueResponse({}, "7", LINK)).toEqual({ id: "7", status: "" });
	});
});
