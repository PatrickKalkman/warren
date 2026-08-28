/**
 * FakeAdo: enough of the Azure DevOps Boards REST 7.1 surface to drive
 * this tracker, in memory.
 *
 * It exists because the useful test of this package is not "does the code
 * run" but "does the tracker survive the warren-tracker/v1 conformance
 * suite", and that needs an Azure DevOps on the other side. It is a
 * `fetch`-shaped function, so it drops straight into {@link AdoClient}'s
 * transport seam with no socket in the way.
 *
 * The payload shapes are transcribed from Microsoft's documented 7.1
 * responses. That is exactly the assumption this package cannot verify
 * without a real organization, so treat FakeAdo as a statement of what
 * this tracker EXPECTS Azure DevOps to return, and the first live run
 * against a real project as the thing that confirms or corrects it.
 */

export interface FakeAdoWorkItem {
	id: number;
	/** The work item type name, such as `User Story` or `Bug`. */
	type: string;
	title?: string;
	/** HTML, as the rich-text editor stores it. */
	description?: string;
	acceptanceCriteria?: string;
	reproSteps?: string;
	state: string;
	/** Ids of the work items that block this one (its predecessors). */
	blockedBy?: number[];
}

export interface FakeAdoState {
	name: string;
	category: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed";
}

export interface FakeAdoOptions {
	readonly items: readonly FakeAdoWorkItem[];
	/** The states every work item type offers. */
	readonly states?: readonly FakeAdoState[];
	/** Fail every call with this status, for the error-mapping tests. */
	readonly failWith?: {
		readonly status: number;
		readonly retryAfter?: string;
		readonly html?: boolean;
	};
}

/** The Agile process template's states, which the sample items use. */
export const AGILE_STATES: readonly FakeAdoState[] = [
	{ name: "New", category: "Proposed" },
	{ name: "Active", category: "InProgress" },
	{ name: "Resolved", category: "Resolved" },
	{ name: "Closed", category: "Completed" },
	{ name: "Removed", category: "Removed" },
];

export interface FakeAdo {
	/** Drop-in for `fetch`, to hand {@link AdoClient}. */
	readonly fetchImpl: typeof fetch;
	/** Live view of the work items, so a test can assert what a close did. */
	readonly items: Map<number, FakeAdoWorkItem>;
	/** Every request as `METHOD path`, in order. */
	readonly calls: string[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function adoError(message: string, status: number, headers: Record<string, string> = {}): Response {
	return json(
		{ $id: "1", innerException: null, message, typeKey: "FakeAdoException" },
		status,
		headers,
	);
}

function workItemBody(item: FakeAdoWorkItem, origin: string): unknown {
	return {
		id: item.id,
		rev: 1,
		fields: {
			"System.Id": item.id,
			"System.WorkItemType": item.type,
			"System.Title": item.title ?? "",
			"System.State": item.state,
			...(item.description !== undefined ? { "System.Description": item.description } : {}),
			...(item.acceptanceCriteria !== undefined
				? { "Microsoft.VSTS.Common.AcceptanceCriteria": item.acceptanceCriteria }
				: {}),
			...(item.reproSteps !== undefined
				? { "Microsoft.VSTS.TCM.ReproSteps": item.reproSteps }
				: {}),
		},
		relations: (item.blockedBy ?? []).map((id) => ({
			rel: "System.LinkTypes.Dependency-Reverse",
			url: `${origin}/_apis/wit/workItems/${id}`,
			attributes: { isLocked: false, name: "Predecessor" },
		})),
		url: `${origin}/_apis/wit/workItems/${item.id}`,
	};
}

const WORK_ITEM = /\/_apis\/wit\/workitems\/(\d+)$/i;
const WIQL = /\/_apis\/wit\/wiql$/i;
const BATCH = /\/_apis\/wit\/workitemsbatch$/i;
const STATES = /\/_apis\/wit\/workitemtypes\/([^/]+)\/states$/i;

async function readBody<T>(init: RequestInit | undefined): Promise<T> {
	return (await new Response(init?.body as BodyInit).json()) as T;
}

export function createFakeAdo(options: FakeAdoOptions): FakeAdo {
	const items = new Map(options.items.map((i) => [i.id, { ...i }]));
	const states = options.states ?? AGILE_STATES;
	const calls: string[] = [];

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input.toString());
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url.pathname}`);

		if (options.failWith !== undefined) return failure(options.failWith);

		const itemMatch = WORK_ITEM.exec(url.pathname);
		if (itemMatch !== null) {
			const id = Number(itemMatch[1]);
			const item = items.get(id);
			if (item === undefined) {
				return adoError(
					`TF401232: Work item ${id} does not exist, or you do not have permissions to read it.`,
					404,
				);
			}
			if (method === "GET") return json(workItemBody(item, url.origin));
			if (method === "PATCH") return patchItem(item, init, url.origin);
		}

		if (method === "POST" && WIQL.test(url.pathname)) {
			const top = Number(url.searchParams.get("$top") ?? Number.MAX_SAFE_INTEGER);
			const ids = [...items.keys()].slice(0, top);
			return json({
				queryType: "flat",
				workItems: ids.map((id) => ({ id, url: `${url.origin}/_apis/wit/workItems/${id}` })),
			});
		}

		if (method === "POST" && BATCH.test(url.pathname)) {
			const body = await readBody<{ ids?: number[] }>(init);
			const ids = body.ids ?? [];
			if (ids.length > 200) return adoError("VS403474: You requested more than 200 ids", 400);
			const found = ids.flatMap((id) => {
				const item = items.get(id);
				return item === undefined ? [] : [{ id, fields: { "System.State": item.state } }];
			});
			return json({ count: found.length, value: found });
		}

		const statesMatch = STATES.exec(url.pathname);
		if (method === "GET" && statesMatch !== null) {
			return json({
				count: states.length,
				value: states.map((s) => ({ name: s.name, color: "b2b2b2", category: s.category })),
			});
		}

		return adoError(`no fake route: ${method} ${url.pathname}`, 404);
	}) as unknown as typeof fetch;

	async function patchItem(
		item: FakeAdoWorkItem,
		init: RequestInit | undefined,
		origin: string,
	): Promise<Response> {
		const ops = await readBody<{ op?: string; path?: string; value?: unknown }[]>(init);
		for (const op of ops) {
			if (op.path !== "/fields/System.State") continue;
			const target = states.find((s) => s.name === op.value);
			if (target === undefined) {
				return adoError(
					`TF401347: The field 'State' contains the value '${op.value}' that is not in the list of supported values`,
					400,
				);
			}
			item.state = target.name;
		}
		return json(workItemBody(item, origin));
	}

	return { fetchImpl, items, calls };
}

function failure(spec: NonNullable<FakeAdoOptions["failWith"]>): Response {
	const headers: Record<string, string> =
		spec.retryAfter === undefined ? {} : { "retry-after": spec.retryAfter };
	if (spec.html === true) {
		return new Response("<html><body>Sign in to Azure DevOps</body></html>", {
			status: spec.status,
			headers: { ...headers, "content-type": "text/html" },
		});
	}
	return adoError("fake azure devops failure", spec.status, headers);
}

/** The fixture the tests and the conformance run share. */
export const SAMPLE_ITEMS: readonly FakeAdoWorkItem[] = [
	{
		id: 96379,
		type: "User Story",
		title: "Show crop from shared groups",
		description:
			"<div>A grower who joined a shared group sees no crop on the dashboard.</div><div><br></div><div>Reproduced on <b>test</b> twice.</div>",
		acceptanceCriteria:
			"<ul><li>Crop is listed for shared groups</li><li>Own groups unchanged</li></ul>",
		state: "New",
		blockedBy: [96380],
	},
	{ id: 96380, type: "Task", title: "Upgrade the groups client", state: "Active" },
	{
		id: 96381,
		type: "Bug",
		title: "Dashboard crashes on empty group",
		reproSteps: "<div>Open a group with no members.</div>",
		state: "Closed",
	},
];
