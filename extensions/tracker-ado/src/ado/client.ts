/**
 * The Azure DevOps Boards REST 7.1 client.
 *
 * Every call goes through {@link AdoClient.request}, so the credential is
 * attached in one place and an upstream failure becomes one error type
 * carrying the status. `fetchImpl` is the seam the tests drive with
 * recorded Azure DevOps payloads.
 *
 * No retries live here. Warren's bridge already retries 429 and 5xx with
 * backoff that honors `Retry-After` (docs/design/issue-tracker.md §5), so
 * this server passes the upstream's answer up rather than growing a
 * second, unsynchronized backoff underneath the first.
 */

import { adoAuthHeader, type AdoTrackerConfig } from "../config.ts";
import {
	ADO_API_VERSION,
	type AdoStatesResponse,
	type AdoWiqlResponse,
	type AdoWorkItem,
	type AdoWorkItemsBatchResponse,
	type AdoWorkItemTypeState,
} from "./types.ts";

/** A non-2xx or unreachable Azure DevOps. `status` is 0 when the call never landed. */
export class AdoApiError extends Error {
	readonly status: number;
	readonly retryAfter: string | null;

	constructor(message: string, status: number, retryAfter: string | null = null) {
		super(message);
		this.name = "AdoApiError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/** The one field the status map needs. */
const STATE_FIELD = "System.State";

export class AdoClient {
	private readonly config: AdoTrackerConfig;
	private readonly fetchImpl: typeof fetch;
	/**
	 * States per work item type, for the life of the process. A process
	 * template changes when an admin edits it, which is rare enough that
	 * a restart is the refresh.
	 */
	private readonly statesByType = new Map<string, readonly AdoWorkItemTypeState[]>();

	constructor(config: AdoTrackerConfig, fetchImpl: typeof fetch = fetch) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	/** Reads the work item with its relations, which is how blockers arrive. */
	async getWorkItem(id: number): Promise<AdoWorkItem> {
		const path = this.witPath(`/workitems/${id}`, { $expand: "relations" });
		return requireObject(await this.request("GET", path), `GET ${path}`) as AdoWorkItem;
	}

	/**
	 * The raw `id -> state` map for every work item the configured WIQL
	 * selects. WIQL answers with ids only, so the states come from a batch
	 * read afterwards, at most 200 ids per call.
	 *
	 * `maxWiqlResults` is the backstop against a query that selects the
	 * whole project. The query asks for one more than the cap, and a
	 * result past the cap throws rather than truncating: a silently short
	 * status map would read to warren as issues that vanished.
	 */
	async issueStatuses(): Promise<Record<string, string>> {
		const ids = await this.queryIds();
		const statuses: Record<string, string> = {};
		for (let start = 0; start < ids.length; start += this.config.batchSize) {
			const chunk = ids.slice(start, start + this.config.batchSize);
			const path = this.witPath("/workitemsbatch");
			const body = requireObject(
				await this.request("POST", path, { ids: chunk, fields: [STATE_FIELD] }),
				`POST ${path}`,
			) as AdoWorkItemsBatchResponse;
			for (const item of body.value ?? []) {
				if (typeof item.id === "number") {
					statuses[String(item.id)] = item.fields?.[STATE_FIELD] ?? "";
				}
			}
		}
		return statuses;
	}

	private async queryIds(): Promise<number[]> {
		const limit = this.config.maxWiqlResults;
		const path = this.witPath("/wiql", { $top: String(limit + 1) });
		const body = requireObject(
			await this.request("POST", path, { query: this.config.wiql }),
			`POST ${path}`,
		) as AdoWiqlResponse;
		const ids: number[] = [];
		for (const ref of body.workItems ?? []) {
			if (typeof ref.id === "number") ids.push(ref.id);
		}
		if (ids.length > limit) {
			throw new AdoApiError(
				`the configured WIQL selected more than ${limit} work items; narrow it or raise ADO_MAX_WIQL_RESULTS`,
				0,
			);
		}
		return ids;
	}

	/** The states a work item type's process defines, with their categories. */
	async states(workItemType: string): Promise<readonly AdoWorkItemTypeState[]> {
		const cached = this.statesByType.get(workItemType);
		if (cached !== undefined) return cached;
		const path = this.witPath(`/workitemtypes/${encodeURIComponent(workItemType)}/states`);
		const body = requireObject(await this.request("GET", path), `GET ${path}`) as AdoStatesResponse;
		const states = body.value ?? [];
		this.statesByType.set(workItemType, states);
		return states;
	}

	/** Moves the work item to `state` and returns it as Azure DevOps now holds it. */
	async setState(id: number, state: string): Promise<AdoWorkItem> {
		const path = this.witPath(`/workitems/${id}`);
		const patch = [{ op: "add", path: `/fields/${STATE_FIELD}`, value: state }];
		return requireObject(
			await this.request("PATCH", path, patch, "application/json-patch+json"),
			`PATCH ${path}`,
		) as AdoWorkItem;
	}

	private witPath(suffix: string, query: Record<string, string> = {}): string {
		const params = new URLSearchParams({ ...query, "api-version": ADO_API_VERSION });
		return `/${encodeURIComponent(this.config.project)}/_apis/wit${suffix}?${params}`;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		contentType = "application/json",
	): Promise<unknown> {
		const headers: Record<string, string> = {
			accept: "application/json",
			authorization: adoAuthHeader(this.config.auth),
		};
		if (body !== undefined) headers["content-type"] = contentType;
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.config.orgUrl}${path}`, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new AdoApiError(`azure devops unreachable: ${reason}`, 0);
		}
		// A rejected or missing credential comes back as 203 with the
		// sign-in page rather than as a 401, so a 2xx that is not JSON is
		// read as a credential failure below rather than as a parse error.
		if (!response.ok || response.status === 203) {
			throw new AdoApiError(
				`azure devops ${method} ${path} failed: ${response.status} ${await errorText(response)}`,
				response.status,
				response.headers.get("retry-after"),
			);
		}
		if (response.status === 204) return undefined;
		const text = await response.text();
		if (text.trim() === "") return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new AdoApiError(`azure devops ${method} ${path} returned a body that is not JSON`, 502);
		}
	}
}

/**
 * A 2xx that carried no object. Every call this client makes expects one,
 * so a proxy answering 200 with an empty body surfaces as the upstream
 * problem it is rather than reaching the mapping as `undefined`.
 */
function requireObject(body: unknown, what: string): object {
	if (body === null || typeof body !== "object") {
		throw new AdoApiError(`azure devops ${what} answered 2xx with no object`, 502);
	}
	return body;
}

/**
 * Azure DevOps error bodies are JSON with a `message` most of the time
 * and an HTML sign-in page the rest of the time, so the text is only ever
 * a diagnostic string. An HTML page reduces to its title, because the
 * markup says nothing and the title ("Azure DevOps Services | Sign In")
 * says everything. It is bounded because it lands in this server's logs
 * and in the message warren surfaces.
 */
async function errorText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text) as { message?: unknown };
			if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
		} catch {
			// Not JSON; fall through to the raw text.
		}
		const title = /<title>([\s\S]*?)<\/title>/i.exec(text);
		if (title?.[1] !== undefined) return `html page "${title[1].replace(/\s+/g, " ").trim()}"`;
		if (/^\s*<(!doctype|html)/i.test(text)) return "html page";
		return text.slice(0, 300);
	} catch {
		return "<unreadable body>";
	}
}
