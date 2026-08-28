/**
 * Profile-declared bot grammar (plan pl-096b step 3, warren-2ec3).
 *
 * Recognition of upstream review bots is *data*, never controller code: a
 * repository profile declares the bot logins it trusts to carry structured
 * findings, the durable-comment marker patterns that make a bot comment a
 * findings digest, the finding-line grammars that extract structured
 * fields, and the comment commands that mark a PR as re-reviewable. The
 * classifier consumes this grammar; nothing upstream says is hardcoded.
 *
 * Patterns compile into `RegExp` at validation time, so a malformed grammar
 * fails closed at profile load, never mid-reconcile. Finding grammars may
 * use named capture groups from the fixed allowlist (`title`, `file`,
 * `line`, `priority`) — everything they extract is untrusted data and every
 * field stamped with untrusted provenance downstream.
 */
import { ValidationError } from "../errors.ts";
import { isValidOwner } from "../github-grammar.ts";
import {
	asObject,
	rejectUnknownKeys,
	requireInt,
	requireString,
	requireStringArray,
} from "../validate-utils.ts";

/** V0 has exactly one bot-grammar schema revision. */
export const BOT_GRAMMAR_SCHEMA_VERSION = 1;

/** Named capture groups a finding-line grammar may declare. */
export const FINDING_GROUP_NAMES = ["title", "file", "line", "priority"] as const;
export type FindingGroupName = (typeof FINDING_GROUP_NAMES)[number];

/** Hard ceiling on pattern source length, bounding regex work. */
export const MAX_PATTERN_LENGTH = 500;

/** One durable-comment marker: a pattern that marks a bot comment as a findings digest. */
export interface CommentMarkerRule {
	readonly id: string;
	/** Case-sensitive source pattern matched anywhere in the comment body. */
	readonly pattern: string;
}

/** One finding-line grammar extracting structured fields from a findings digest. */
export interface FindingLineRule {
	readonly id: string;
	/** Multiline pattern; named groups from `FINDING_GROUP_NAMES` become fields. */
	readonly pattern: string;
}

/** One re-review command: a pattern a comment body must match in full. */
export interface ReReviewCommandRule {
	readonly id: string;
	readonly pattern: string;
}

/** The profile-declared recognition rules for one upstream repository. */
export interface BotGrammar {
	readonly schemaVersion: typeof BOT_GRAMMAR_SCHEMA_VERSION;
	/** Upstream accounts whose automated activity the profile recognizes. */
	readonly botLogins: string[];
	/** Bot logins whose marker-matched comments carry structured findings. */
	readonly reviewBotLogins: string[];
	readonly durableCommentMarkers: readonly CommentMarkerRule[];
	readonly findingLineGrammars: readonly FindingLineRule[];
	readonly reReviewCommands: readonly ReReviewCommandRule[];
}

const TOP_LEVEL_FIELDS = [
	"schemaVersion",
	"botLogins",
	"reviewBotLogins",
	"durableCommentMarkers",
	"findingLineGrammars",
	"reReviewCommands",
] as const;

const MARKER_FIELDS = ["id", "pattern"] as const;
const FINDING_FIELDS = ["id", "pattern"] as const;
const COMMAND_FIELDS = ["id", "pattern"] as const;

/** Marker/finding/command ids: short, unique, lowercase kebab. */
const RULE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function requireRuleArray(
	value: Record<string, unknown>,
	key: string,
	path: string,
	fields: readonly string[],
): Array<{ id: string; pattern: string }> {
	const raw = value[key];
	if (!Array.isArray(raw)) {
		throw new ValidationError(`expected an array at '${path}.${key}'`);
	}
	const seenIds = new Set<string>();
	return raw.map((item, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new ValidationError(`expected an object at '${path}.${key}[${index}]'`);
		}
		const obj = asObject(item, `${path}.${key}[${index}]`);
		rejectUnknownKeys(obj, fields, `${path}.${key}[${index}]`);
		const id = requireString(obj, "id", `${path}.${key}[${index}]`, {
			pattern: RULE_ID_PATTERN,
			patternHint: "a lowercase kebab id of at most 64 characters",
		});
		if (seenIds.has(id)) {
			throw new ValidationError(`duplicate rule id "${id}" at '${path}.${key}'`);
		}
		seenIds.add(id);
		const pattern = requireString(obj, "pattern", `${path}.${key}[${index}]`, {
			min: 1,
			max: MAX_PATTERN_LENGTH,
		});
		compilePattern(pattern, `${path}.${key}[${index}].pattern`);
		return { id, pattern };
	});
}

function compilePattern(pattern: string, path: string): RegExp {
	try {
		return new RegExp(pattern);
	} catch {
		throw new ValidationError(`invalid regular expression at '${path}'`);
	}
}

/**
 * Validate and normalize a profile-declared bot grammar. Throws
 * `ValidationError` on any violation: unknown keys, bad logins, duplicate
 * rule ids, non-compiling patterns, or finding grammars that declare
 * capture groups outside the fixed allowlist.
 */
export function validateBotGrammar(value: unknown, path = "botGrammar"): BotGrammar {
	const obj = asObject(value, path);
	rejectUnknownKeys(obj, TOP_LEVEL_FIELDS, path);
	requireInt(obj, "schemaVersion", path, {
		min: BOT_GRAMMAR_SCHEMA_VERSION,
		max: BOT_GRAMMAR_SCHEMA_VERSION,
	});

	const botLogins = requireStringArray(obj, "botLogins", path, { maxItems: 64, maxLen: 39 });
	for (const login of botLogins) {
		if (!isValidOwner(login)) {
			throw new ValidationError(`invalid bot login "${login}" at '${path}.botLogins'`);
		}
	}
	const reviewBotLogins = requireStringArray(obj, "reviewBotLogins", path, {
		maxItems: 64,
		maxLen: 39,
	});
	for (const login of reviewBotLogins) {
		if (!botLogins.includes(login)) {
			throw new ValidationError(
				`review bot login "${login}" at '${path}.reviewBotLogins' is not declared in 'botLogins'`,
			);
		}
	}

	const markers = requireRuleArray(obj, "durableCommentMarkers", path, MARKER_FIELDS);
	const findings = requireRuleArray(obj, "findingLineGrammars", path, FINDING_FIELDS);
	for (const rule of findings) {
		const groups = new RegExp(rule.pattern).source.match(/\(\?<([a-zA-Z]+)>/g) ?? [];
		for (const group of groups) {
			const name = group.slice(3, -1);
			if (!FINDING_GROUP_NAMES.includes(name as FindingGroupName)) {
				throw new ValidationError(
					`finding grammar "${rule.id}" declares capture group "${name}" outside the allowed set [${FINDING_GROUP_NAMES.join(", ")}]`,
				);
			}
		}
	}
	const commands = requireRuleArray(obj, "reReviewCommands", path, COMMAND_FIELDS);

	return {
		schemaVersion: BOT_GRAMMAR_SCHEMA_VERSION,
		botLogins,
		reviewBotLogins,
		durableCommentMarkers: markers,
		findingLineGrammars: findings,
		reReviewCommands: commands,
	};
}
