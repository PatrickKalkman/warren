/**
 * Review-feedback classification (plan pl-096b step 3, warren-2ec3).
 *
 * Pure and deterministic: reconciled upstream snapshots plus a
 * profile-declared bot grammar in, structured feedback candidates out.
 * Categories: `failing_check`, `changes_requested`,
 * `review_bot_findings`, `maintainer_question`, `re_review_available`,
 * `pr_merged`, `pr_closed`.
 *
 * Untrusted-input discipline is absolute. Every candidate carries only
 * structured extracted fields (check names, file paths, finding titles,
 * line numbers, priorities) and each field is stamped untrusted
 * provenance. Raw comment bodies never reach the output, and no comment
 * text can name or trigger a controller action — recognition runs against
 * profile-declared patterns only, and the output is inert data for the
 * follow-up coordinator to interpret.
 */
import type {
	GithubCheckRunSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";
import type { BotGrammar } from "./bot-grammar.ts";

/** Every feedback category the classifier emits. */
export type FeedbackCategory =
	| "failing_check"
	| "changes_requested"
	| "review_bot_findings"
	| "maintainer_question"
	| "re_review_available"
	| "pr_merged"
	| "pr_closed";

/** Provenance class of a feedback row. All upstream-derived fields are untrusted. */
export type FeedbackProvenance = "untrusted";

/** Structured extracted field values: primitives, primitive arrays, and flat finding objects. */
export type FeedbackFieldValue =
	| string
	| number
	| readonly (string | number | Record<string, string | number>)[];

/** One classified, structured feedback candidate. */
export interface FeedbackCandidate {
	/** Source event identity (the upstream node id), for durable dedupe. */
	readonly sourceNodeId: string;
	readonly category: FeedbackCategory;
	/** Structured extracted fields only — never a raw comment body. */
	readonly fields: Record<string, FeedbackFieldValue>;
	/** Every field above is untrusted upstream-derived data. */
	readonly provenance: FeedbackProvenance;
}

/** The comment fields classification reads — raw snapshots satisfy this structurally. */
export type ClassifiableComment = Pick<
	GithubIssueCommentSnapshot,
	"nodeId" | "authorLogin" | "authorAssociation" | "body"
>;

/** Inputs one classification pass runs over. All snapshots come from one PR read. */
export interface ClassificationInput {
	readonly pr: GithubPullRequestSnapshot | null;
	readonly reviews: readonly GithubReviewSnapshot[];
	readonly issueComments: readonly ClassifiableComment[];
	readonly reviewComments: readonly ClassifiableComment[];
	readonly checkRuns: readonly GithubCheckRunSnapshot[];
	/** Profile-declared recognition rules for the upstream repository. */
	readonly grammar: BotGrammar;
}

/** Check-run conclusions that classify as a failing check. */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/** Author associations that count as a maintainer voice. */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** One structured finding extracted from a bot findings digest. */
type ExtractedFinding = Record<string, string | number>;

function isBot(login: string, grammar: BotGrammar): boolean {
	return grammar.botLogins.includes(login);
}

function candidate(
	sourceNodeId: string,
	category: FeedbackCategory,
	fields: Record<string, FeedbackFieldValue>,
): FeedbackCandidate {
	return { sourceNodeId, category, fields, provenance: "untrusted" };
}

/** Extract findings from one comment body under the first matching durable marker. */
function extractFindings(body: string, grammar: BotGrammar): ExtractedFinding[] {
	for (const marker of grammar.durableCommentMarkers) {
		if (!new RegExp(marker.pattern).test(body)) continue;
		const findings: ExtractedFinding[] = [];
		for (const lineGrammar of grammar.findingLineGrammars) {
			for (const match of body.matchAll(new RegExp(lineGrammar.pattern, "gm"))) {
				const finding = namedFields(match);
				if (Object.keys(finding).length > 0) findings.push(finding);
			}
		}
		return findings;
	}
	return [];
}

/** Collect the grammar-allowed named capture groups of one match. */
function namedFields(match: RegExpMatchArray): ExtractedFinding {
	const finding: ExtractedFinding = {};
	const groups = match.groups;
	if (groups === undefined) return finding;
	if (groups.title !== undefined) finding.title = groups.title;
	if (groups.file !== undefined) finding.file = groups.file;
	if (groups.line !== undefined) {
		const line = Number.parseInt(groups.line, 10);
		if (Number.isFinite(line)) finding.line = line;
	}
	if (groups.priority !== undefined) finding.priority = groups.priority;
	return finding;
}

/** The re-review command a comment body matches in full, if any. */
function matchedReReviewCommand(body: string, grammar: BotGrammar): string | null {
	const trimmed = body.trim();
	for (const command of grammar.reReviewCommands) {
		if (new RegExp(`^(?:${command.pattern})$`).test(trimmed)) return command.id;
	}
	return null;
}

/** Classify one comment into at most one candidate. */
function classifyComment(
	comment: ClassifiableComment,
	grammar: BotGrammar,
): FeedbackCandidate | null {
	const bot = isBot(comment.authorLogin, grammar);
	if (bot && grammar.reviewBotLogins.includes(comment.authorLogin)) {
		const findings = extractFindings(comment.body, grammar);
		if (findings.length > 0) {
			return candidate(comment.nodeId, "review_bot_findings", { findings });
		}
	}
	const commandId = matchedReReviewCommand(comment.body, grammar);
	if (commandId !== null) {
		return candidate(comment.nodeId, "re_review_available", {
			commandId,
			authorLogin: comment.authorLogin,
		});
	}
	if (
		!bot &&
		MAINTAINER_ASSOCIATIONS.has(comment.authorAssociation) &&
		comment.body.includes("?")
	) {
		return candidate(comment.nodeId, "maintainer_question", {
			authorLogin: comment.authorLogin,
			association: comment.authorAssociation,
		});
	}
	return null;
}

function classifyComments(
	comments: readonly ClassifiableComment[],
	grammar: BotGrammar,
	out: FeedbackCandidate[],
): void {
	for (const comment of comments) {
		const result = classifyComment(comment, grammar);
		if (result !== null) out.push(result);
	}
}

function classifyPr(pr: GithubPullRequestSnapshot, out: FeedbackCandidate[]): void {
	if (pr.mergedAt !== null) {
		out.push(candidate(pr.nodeId, "pr_merged", {}));
	} else if (pr.closedAt !== null) {
		out.push(candidate(pr.nodeId, "pr_closed", {}));
	}
}

function classifyReviews(
	reviews: readonly GithubReviewSnapshot[],
	grammar: BotGrammar,
	out: FeedbackCandidate[],
): void {
	for (const review of reviews) {
		if (review.state === "CHANGES_REQUESTED" && !isBot(review.authorLogin, grammar)) {
			out.push(
				candidate(review.nodeId, "changes_requested", {
					authorLogin: review.authorLogin,
					reviewUrl: review.htmlUrl,
				}),
			);
		}
	}
}

function classifyChecks(
	checkRuns: readonly GithubCheckRunSnapshot[],
	out: FeedbackCandidate[],
): void {
	for (const check of checkRuns) {
		if (check.conclusion !== null && FAILING_CONCLUSIONS.has(check.conclusion)) {
			out.push(
				candidate(check.nodeId, "failing_check", {
					checkName: check.name,
					conclusion: check.conclusion,
					url: check.htmlUrl,
				}),
			);
		}
	}
}

/**
 * Classify one reconciled PR observation into structured feedback
 * candidates. Deterministic in input; emits at most one candidate per
 * (source node id, category) pair.
 */
export function classifyFeedback(input: ClassificationInput): FeedbackCandidate[] {
	const out: FeedbackCandidate[] = [];
	const { pr, grammar } = input;
	if (pr !== null) classifyPr(pr, out);
	classifyReviews(input.reviews, grammar, out);
	classifyComments(input.issueComments, grammar, out);
	classifyComments(input.reviewComments, grammar, out);
	classifyChecks(input.checkRuns, out);
	return out;
}
