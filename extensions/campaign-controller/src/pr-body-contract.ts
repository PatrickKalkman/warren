/**
 * The PR-body contract as versioned profile data (warren-e361, plan
 * pl-096b phase 3).
 *
 * Every section heading, the AI-disclosure paragraph, and the footer were
 * once hardcoded in the intender's renderBody(), tuned to one upstream CI
 * gate. They are data now: an ordered list of sections (stable key,
 * rendered heading, required flag) plus a closes line, a disclosure
 * body template, and a footer template with named placeholders. The
 * intender walks the contract; it declares no headings of its own.
 *
 * Contracts are committed under `profiles/` — one per repository profile,
 * plus a generic `default` used when the profile has no contract of its
 * own. `resolvePrBodyContract()` validates the loaded data fail-closed at
 * module load: a malformed contract never reaches a render.
 */
import defaultContractJson from "../profiles/default.pr-body-contract.json";
import openclawContractJson from "../profiles/openclaw.pr-body-contract.json";

/** The stable keys a contract's sections may use. Each maps to a fact. */
export const PR_BODY_SECTION_KEYS = [
	"disclosure",
	"problem",
	"solution",
	"userImpact",
	"evidence",
	"runReference",
	"operatorNotes",
] as const;

export type PrBodySectionKey = (typeof PR_BODY_SECTION_KEYS)[number];

/** One ordered section of the rendered PR body. */
export interface PrBodySection {
	/** Stable identifier the renderer maps to a content fact. */
	readonly key: PrBodySectionKey;
	/** The literal `##` heading rendered for this section. */
	readonly heading: string;
	/** When true, empty content refuses the render. */
	readonly required: boolean;
	/** Template with `{named}` placeholders filled at render time. */
	readonly bodyTemplate: string;
}

/** The full PR-body contract for one repository profile. */
export interface PrBodyContract {
	readonly contractVersion: 1;
	/** The repository profile this contract renders for. */
	readonly profileId: string;
	/** The `Closes #N` line template. */
	readonly closesTemplate: string;
	/** Ordered sections; the render follows this order exactly. */
	readonly sections: readonly PrBodySection[];
	/** The trailing footer template. */
	readonly footerTemplate: string;
}

const SECTION_KEYS = new Set<string>(PR_BODY_SECTION_KEYS);

/** Fail-closed shape check for one contract section. */
function validatePrBodySection(section: unknown, source: string): PrBodySection {
	if (typeof section !== "object" || section === null) {
		throw new Error(`PR-body contract ${source} has a non-object section`);
	}
	const entry = section as Record<string, unknown>;
	const key = entry.key;
	if (typeof key !== "string" || !SECTION_KEYS.has(key)) {
		throw new Error(`PR-body contract ${source} has an unknown section key`);
	}
	for (const field of ["heading", "bodyTemplate"] as const) {
		if (typeof entry[field] !== "string") {
			throw new Error(`PR-body contract ${source} section ${key} has no ${field}`);
		}
	}
	if (typeof entry.required !== "boolean") {
		throw new Error(`PR-body contract ${source} section ${key} has no required flag`);
	}
	return entry as unknown as PrBodySection;
}

/** Fail-closed shape check so a malformed profile never renders. */
function validatePrBodyContract(value: unknown, source: string): PrBodyContract {
	if (typeof value !== "object" || value === null) {
		throw new Error(`PR-body contract ${source} is not an object`);
	}
	const root = value as Record<string, unknown>;
	if (root.contractVersion !== 1) {
		throw new Error(`PR-body contract ${source} must declare contractVersion 1`);
	}
	if (typeof root.profileId !== "string" || root.profileId.length === 0) {
		throw new Error(`PR-body contract ${source} has no profileId`);
	}
	for (const field of ["closesTemplate", "footerTemplate"] as const) {
		if (typeof root[field] !== "string") {
			throw new Error(`PR-body contract ${source} has no ${field}`);
		}
	}
	if (!Array.isArray(root.sections) || root.sections.length === 0) {
		throw new Error(`PR-body contract ${source} declares no sections`);
	}
	const sections = root.sections.map((section) => validatePrBodySection(section, source));
	const seen = new Set<string>();
	for (const section of sections) {
		if (seen.has(section.key)) {
			throw new Error(`PR-body contract ${source} repeats section key ${section.key}`);
		}
		seen.add(section.key);
	}
	return { ...(root as unknown as PrBodyContract), sections };
}

const DEFAULT_PR_BODY_CONTRACT = validatePrBodyContract(
	defaultContractJson,
	"default.pr-body-contract.json",
);
const OPENCLAW_PR_BODY_CONTRACT = validatePrBodyContract(
	openclawContractJson,
	"openclaw.pr-body-contract.json",
);

/** Resolve the PR-body contract for a repository profile. */
export function resolvePrBodyContract(profileId: string): PrBodyContract {
	if (profileId === "openclaw") {
		return OPENCLAW_PR_BODY_CONTRACT;
	}
	return DEFAULT_PR_BODY_CONTRACT;
}

/**
 * Fill `{named}` placeholders from the render context. An unknown
 * placeholder is left verbatim so a template typo is visible in the
 * evidence instead of silently dropping a fact.
 */
export function interpolateTemplate(template: string, context: Record<string, string>): string {
	return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key: string) =>
		key in context ? (context[key] as string) : match,
	);
}
