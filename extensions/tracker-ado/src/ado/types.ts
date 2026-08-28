/**
 * The slice of the Azure DevOps Boards REST 7.1 response shapes this
 * tracker reads.
 *
 * Everything is optional on purpose. A work item carries only the fields
 * its process template defines, a relation can arrive without attributes,
 * and a proxy can strip things, so the mapping narrows rather than
 * trusts. Nothing here is an SDK type import: the payloads cross an HTTP
 * boundary, so they are parsed, not asserted.
 */

export const ADO_API_VERSION = "7.1";

/** The fields this tracker reads, by their reference names. */
export interface AdoWorkItemFields {
	readonly "System.Title"?: string | null;
	/** HTML on every process template. */
	readonly "System.Description"?: string | null;
	readonly "System.State"?: string | null;
	readonly "System.WorkItemType"?: string | null;
	/** HTML; present on stories and bugs in Agile and Scrum. */
	readonly "Microsoft.VSTS.Common.AcceptanceCriteria"?: string | null;
	/** HTML; a bug in Agile carries its narrative here instead of the description. */
	readonly "Microsoft.VSTS.TCM.ReproSteps"?: string | null;
}

export interface AdoRelation {
	/** The link type reference name, such as `System.LinkTypes.Dependency-Reverse`. */
	readonly rel?: string;
	/** The linked work item's REST url; the id is its last path segment. */
	readonly url?: string;
}

export interface AdoWorkItem {
	readonly id?: number;
	readonly fields?: AdoWorkItemFields;
	readonly relations?: readonly AdoRelation[];
}

interface AdoWorkItemReference {
	readonly id?: number;
	readonly url?: string;
}

/** `POST /_apis/wit/wiql` response for a flat query. */
export interface AdoWiqlResponse {
	readonly workItems?: readonly AdoWorkItemReference[];
}

/** `POST /_apis/wit/workitemsbatch` response. */
export interface AdoWorkItemsBatchResponse {
	readonly count?: number;
	readonly value?: readonly AdoWorkItem[];
}

export interface AdoWorkItemTypeState {
	readonly name?: string;
	/** One of `Proposed`, `InProgress`, `Resolved`, `Completed`, `Removed`. */
	readonly category?: string;
}

/** `GET /_apis/wit/workitemtypes/{type}/states` response. */
export interface AdoStatesResponse {
	readonly value?: readonly AdoWorkItemTypeState[];
}

/** The state category every finished work item lands in. */
export const ADO_COMPLETED_CATEGORY = "Completed";

/** The state category of a work item taken off the backlog without finishing. */
export const ADO_REMOVED_CATEGORY = "Removed";
