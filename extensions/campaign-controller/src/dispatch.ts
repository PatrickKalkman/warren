/**
 * Durable Warren dispatch and restart reconciliation (plan pl-91b6 step 7,
 * warren-2a0a).
 *
 * The state machine that converts one admitted work item into a Warren run
 * without duplicate paid work (design record §9–§10, plan risk 2):
 *
 * - `planDispatch` commits, inside ONE transaction, the full per-run budget
 *   reservation (binding admission's reservation to the action), a
 *   deterministic dispatch action row in `planned` state, and the exact
 *   request digest — all before any I/O. A crash after this commit leaves a
 *   durable record of exactly what was about to be sent.
 * - `executeDispatch` sends the POST with the stable idempotency key (the
 *   action key). A confirmed response persists the run correlation
 *   atomically. An ambiguous POST outcome (network loss after send, 5xx)
 *   settles the action `uncertain`, moves the work item to
 *   `dispatch_uncertain`, creates an attention item, and is NEVER retried —
 *   warren's idempotency store is not durable across restarts, so a blind
 *   repeat could duplicate paid work.
 * - `reconcileCampaignRuns` reads known runs through authoritative GETs
 *   until terminal, then records the pushed branch/ref and structured
 *   outcome on the run link, settles the actual cost against the
 *   reservation, and — when the terminal cost is unknown — preserves the
 *   conservative reservation and raises attention instead of guessing.
 * - `recoverFromRestart` is the boot-time sweep: expire leases, resume
 *   known-run reads for actions with a correlated run, fail closed into
 *   `dispatch_uncertain` for any dispatch whose outcome is unknown, and
 *   reconstruct missing reservations so the ledger can never under-count.
 *
 * This module performs no GitHub I/O and renders no PR intents; those are
 * later plan steps. It mutates Warren through the dispatch POST only.
 */
import { digestOf } from "./digest.ts";
import { CampaignControllerError, StateError } from "./errors.ts";
import type { CampaignManifest } from "./manifest.ts";
import type { CampaignStateStore } from "./store/state-store.ts";
import type {
	ActionRow,
	CampaignRow,
	ReservationRow,
	RunLinkRow,
	WorkItemRow,
} from "./store/types.ts";
import {
	DispatchUncertainError,
	type WarrenClient,
	WarrenEnvelopeError,
	WarrenRateLimitError,
	WarrenRejectedError,
	WarrenAuthError,
	isTerminalRunState,
} from "./warren-client.ts";

/** The one action type this module journals. */
export const DISPATCH_ACTION_TYPE = "warren_dispatch";

/** Lease scope for one work item's dispatch path. */
const leaseScope = (campaignId: string, workItemId: string): string =>
	`dispatch:${campaignId}:${workItemId}`;

/** Terminal work-item statuses — never touched by reconciliation again. */
const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

function usdToCents(usd: number): number {
	return Math.round(usd * 100);
}

function manifestOf(campaign: CampaignRow): CampaignManifest {
	try {
		return JSON.parse(campaign.manifestJson) as CampaignManifest;
	} catch (cause) {
		throw new StateError(`stored manifest of campaign ${campaign.id} is not valid JSON`, {
			cause,
		});
	}
}

/**
 * The exact dispatch request body this campaign sends (field-for-field what
 * the Warren client serializes). The digest over this object is what the
 * journal binds, so "same action key" always means "same paid request".
 */
export function dispatchRequestBody(
	manifest: CampaignManifest,
): {
	agent: string;
	project: string;
	prompt: string;
	provider: string;
	model: string;
	maxCostUsd: number;
} {
	if (manifest.prompt === undefined) {
		throw new StateError(
			`campaign ${manifest.campaignId} carries only a promptDigest; V0 dispatch requires the full prompt`,
		);
	}
	return {
		agent: manifest.warren.agent,
		project: manifest.warren.project,
		prompt: manifest.prompt,
		provider: manifest.warren.provider,
		model: manifest.warren.model,
		maxCostUsd: manifest.budget.perRunUsd,
	};
}

/** The stable idempotency key for one work item's dispatch attempt cycle. */
export function dispatchActionKey(campaignId: string, workItemId: string): string {
	return `${DISPATCH_ACTION_TYPE}:${campaignId}:${workItemId}`;
}

export interface PlanDispatchInput {
	readonly campaignId: string;
	readonly workItemId: string;
	/** The reservation `admitWorkItem` returned (the full per-run cap). */
	readonly reservationId: string;
	readonly nowMs: number;
}

export interface PlanDispatchResult {
	readonly action: ActionRow;
	readonly reservation: ReservationRow;
}

function requireCampaignForDispatch(store: CampaignStateStore, campaignId: string, nowMs: number) {
	const campaign = store.campaigns.getCampaign(campaignId);
	if (campaign === null) throw new StateError(`unknown campaign: ${campaignId}`);
	if (campaign.approvedAtMs === null) {
		throw new StateError(`campaign ${campaignId} is not approved; dispatch is refused`);
	}
	const manifest = manifestOf(campaign);
	if (nowMs >= Date.parse(manifest.expiresAt)) {
		throw new StateError(
			`campaign ${campaignId} expired at ${manifest.expiresAt}; dispatch is refused`,
		);
	}
	return { campaign, manifest };
}

/**
 * Atomically reserve the full run cap and persist the deterministic dispatch
 * action plus its exact request digest — before any I/O. Idempotent on the
 * action key: replanning the same admitted dispatch (same digest) returns
 * the existing planned row; a different digest under the same key fails
 * closed because it would silently change paid work.
 */
export function planDispatch(
	store: CampaignStateStore,
	input: PlanDispatchInput,
): PlanDispatchResult {
	const { campaign, manifest } = requireCampaignForDispatch(store, input.campaignId, input.nowMs);
	const workItem = store.campaigns.getWorkItem(input.workItemId);
	if (workItem === null) throw new StateError(`unknown work item: ${input.workItemId}`);
	if (workItem.campaignId !== campaign.id) {
		throw new StateError(`work item ${input.workItemId} does not belong to campaign ${campaign.id}`);
	}
	const actionKey = dispatchActionKey(campaign.id, workItem.id);
	const body = dispatchRequestBody(manifest);
	const requestDigest = digestOf(body);
	const perRunCents = usdToCents(manifest.budget.perRunUsd);

	// Idempotent replan of an already-planned (crash-recovered) intent.
	const existing = store.actions.getActionByKey(actionKey);
	if (existing !== null) {
		if (existing.requestDigest !== requestDigest) {
			throw new StateError(
				`dispatch action ${actionKey} is bound to a different request digest; paid work cannot silently change`,
			);
		}
		if (existing.state !== "planned") {
			throw new StateError(`dispatch action ${actionKey} is ${existing.state}; cannot replan`);
		}
		const reservation = store.budget.getActiveReservationForAction(existing.id);
		if (reservation === null) {
			throw new StateError(
				`planned dispatch action ${actionKey} has no active reservation; run restart recovery first`,
			);
		}
		return { action: existing, reservation };
	}
	if (workItem.status !== "admitted") {
		throw new StateError(
			`work item ${workItem.id} is ${workItem.status}; only admitted work may plan dispatch`,
		);
	}

	return store.transaction(() => {
		const reservation = store.budget.getReservation(input.reservationId);
		if (
			reservation === null ||
			reservation.campaignId !== campaign.id ||
			reservation.state !== "active"
		) {
			throw new StateError(
				`reservation ${input.reservationId} is not an active reservation of campaign ${campaign.id}`,
			);
		}
		if (reservation.amountUsdCents !== perRunCents) {
			throw new StateError(
				`reservation ${input.reservationId} reserves ${reservation.amountUsdCents}c, but the per-run cap is ${perRunCents}c`,
			);
		}
		const action = store.actions.beginAction({
			actionKey,
			campaignId: campaign.id,
			workItemId: workItem.id,
			actionType: DISPATCH_ACTION_TYPE,
			requestDigest,
			policyDigest: campaign.policyDigest,
			reservedUsdCents: perRunCents,
		});
		const bound = store.budget.attachReservationAction(reservation.id, action.id);
		store.campaigns.setWorkItemStatus(workItem.id, "dispatch_intent");
		return { action, reservation: bound };
	});
}

/** Everything the dispatch engine needs; the Warren client is the only I/O. */
export interface DispatchDeps {
	readonly store: CampaignStateStore;
	readonly warren: WarrenClient;
	/** Lease holder identity; distinct processes must use distinct holders. */
	readonly holder?: string;
	/** Dispatch lease TTL in ms. Default 60 000. */
	readonly leaseTtlMs?: number;
}

export type DispatchOutcomeStatus = "dispatched" | "dispatch_uncertain" | "rejected" | "rate_limited";

export interface DispatchOutcome {
	readonly status: DispatchOutcomeStatus;
	readonly action: ActionRow;
	readonly runId: string | null;
	readonly workItem: WorkItemRow;
}

/**
 * Execute one dispatch: plan (intent-before-I/O), POST with the stable
 * idempotency key, then durably correlate the confirmed run. Ambiguous POST
 * outcomes fail closed into `dispatch_uncertain` + attention and are never
 * retried by this or any later call.
 */
export async function executeDispatch(
	deps: DispatchDeps,
	input: PlanDispatchInput,
): Promise<DispatchOutcome> {
	const { campaign, manifest } = requireCampaignForDispatch(
		deps.store,
		input.campaignId,
		input.nowMs,
	);
	const plan = planDispatch(deps.store, input);
	const actionKey = plan.action.actionKey;
	deps.store.actions.markExecuting(plan.action.id);
	const body = dispatchRequestBody(manifest);
	let run;
	try {
		run = await deps.warren.dispatchRun({ ...body, idempotencyKey: actionKey });
	} catch (cause) {
		return settleFailedDispatch(deps.store, campaign.id, plan.action, cause);
	}
	deps.store.transaction(() => {
		deps.store.events.correlateRun({
			runId: run.id,
			campaignId: campaign.id,
			workItemId: plan.action.workItemId,
			actionId: plan.action.id,
			branch: run.targetBranch,
		});
		deps.store.actions.settleAction(plan.action.id, {
			state: "succeeded",
			resultRunId: run.id,
			resultBranch: run.targetBranch,
		});
		if (plan.action.workItemId !== null) {
			deps.store.campaigns.setWorkItemStatus(plan.action.workItemId, "running");
		}
		if (campaign.status === "approved") {
			deps.store.campaigns.setCampaignStatus(campaign.id, "running");
		}
	});
	return {
		status: "dispatched",
		action: deps.store.actions.getAction(plan.action.id) as ActionRow,
		runId: run.id,
		workItem: deps.store.campaigns.getWorkItem(input.workItemId) as WorkItemRow,
	};
}

/** Classify and durably settle a failed POST. Never retries, never POSTs again. */
function settleFailedDispatch(
	store: CampaignStateStore,
	campaignId: string,
	action: ActionRow,
	cause: unknown,
): DispatchOutcome {
	const workItemId = action.workItemId;
	const settle = (input: Parameters<typeof store.actions.settleAction>[1]) =>
		store.actions.settleAction(action.id, input);
	if (cause instanceof WarrenRateLimitError) {
		// Rejected before acceptance — unambiguous, so no run exists. The
		// reservation is released and a later cycle may admit again.
		store.transaction(() => {
			settle({
				state: "retryable_failure",
				errorClass: "unknown",
				errorJson: JSON.stringify({ message: cause.message, retryAfterMs: cause.retryAfterMs }),
			});
			if (workItemId !== null) store.campaigns.setWorkItemStatus(workItemId, "retry_pending");
			const reservation = store.budget.getActiveReservationForAction(action.id);
			if (reservation !== null) store.budget.releaseReservation(reservation.id);
			store.events.addAttention({
				campaignId,
				workItemId,
				reason: "dispatch_rate_limited",
				detailJson: JSON.stringify({ actionKey: action.actionKey, retryAfterMs: cause.retryAfterMs }),
			});
		});
		return outcome(store, "rate_limited", action.id, workItemId);
	}
	if (
		cause instanceof WarrenRejectedError ||
		cause instanceof WarrenAuthError ||
		cause instanceof WarrenEnvelopeError
	) {
		// Considered rejection: no run was created. Release the reservation
		// and record the structured outcome without advancing the campaign.
		store.transaction(() => {
			settle({
				state: "permanent_failure",
				errorClass: "warren_rejected",
				errorJson: JSON.stringify({
					message: cause.message,
					code: cause instanceof CampaignControllerError ? cause.code : null,
				}),
			});
			if (workItemId !== null) store.campaigns.setWorkItemStatus(workItemId, "needs_attention");
			const reservation = store.budget.getActiveReservationForAction(action.id);
			if (reservation !== null) store.budget.releaseReservation(reservation.id);
			store.events.addAttention({
				campaignId,
				workItemId,
				reason: "dispatch_rejected",
				detailJson: JSON.stringify({ actionKey: action.actionKey, message: cause.message }),
			});
		});
		return outcome(store, "rejected", action.id, workItemId);
	}
	// DispatchUncertainError — and, fail closed, any unrecognized failure:
	// the outcome is unknown. The reservation stays (conservative), the work
	// item enters dispatch_uncertain, and nothing here or later ever POSTs
	// this dispatch again.
	const message = cause instanceof Error ? cause.message : String(cause);
	store.transaction(() => {
		settle({
			state: "uncertain",
			errorClass: "ambiguous_response",
			errorJson: JSON.stringify({ message }),
		});
		if (workItemId !== null) store.campaigns.setWorkItemStatus(workItemId, "dispatch_uncertain");
		store.events.addAttention({
			campaignId,
			workItemId,
			reason: "dispatch_uncertain",
			detailJson: JSON.stringify({
				actionKey: action.actionKey,
				idempotencyKey: action.actionKey,
				message,
			}),
		});
	});
	return outcome(store, "dispatch_uncertain", action.id, workItemId);
}

function outcome(
	store: CampaignStateStore,
	status: DispatchOutcomeStatus,
	actionId: string,
	workItemId: string | null,
): DispatchOutcome {
	return {
		status,
		action: store.actions.getAction(actionId) as ActionRow,
		runId: null,
		workItem: store.campaigns.getWorkItem(workItemId as string) as WorkItemRow,
	};
}

export interface DispatchTickInput extends PlanDispatchInput {
	/** Distinct per concurrent tick caller; two ticks with one holder fuse. */
	readonly holder?: string;
}

export interface DispatchTickResult {
	readonly skipped: boolean;
	readonly reason?: "lease_held";
	readonly outcome?: DispatchOutcome;
}

/**
 * One leased dispatch tick: acquire the per-work-item lease, execute the
 * dispatch, release. A concurrent tick on the same work item skips instead
 * of racing, so two ticks can never produce two POSTs.
 */
export async function dispatchTick(
	deps: DispatchDeps,
	input: DispatchTickInput,
): Promise<DispatchTickResult> {
	const holder = input.holder ?? deps.holder ?? "campaign-controller";
	const scope = leaseScope(input.campaignId, input.workItemId);
	const lease = deps.store.leases.acquireLease(scope, holder, deps.leaseTtlMs ?? 60_000);
	if (lease === null) {
		return { skipped: true, reason: "lease_held" };
	}
	try {
		return { skipped: false, outcome: await executeDispatch(deps, input) };
	} finally {
		deps.store.leases.releaseLease(scope, holder);
	}
}

export interface ReconciledRun {
	readonly runId: string;
	readonly workItemStatus: WorkItemStatus | null;
	/** True once terminal facts are durably recorded. */
	readonly settled: boolean;
	/** False when terminal cost was unknown and the reservation stays active. */
	readonly costKnown: boolean;
}

/**
 * Reconcile every known run of a campaign through authoritative GET reads.
 * Non-terminal runs are left running; terminal runs get their pushed
 * branch/ref and structured outcome recorded, their reservation settled at
 * the ACTUAL cost (or conservatively kept when the cost is unknown), and
 * their work item completed/failed without advancing later issues.
 */
export async function reconcileCampaignRuns(
	deps: DispatchDeps,
	campaignId: string,
): Promise<ReconciledRun[]> {
	const results: ReconciledRun[] = [];
	for (const link of deps.store.events.listRunLinks(campaignId)) {
		if (link.terminalState !== null) {
			results.push({
				runId: link.runId,
				workItemStatus: link.workItemId === null ? null : workItemStatus(deps, link),
				settled: true,
				costKnown: link.terminalCostUsdCents !== null,
			});
			continue;
		}
		const run = await deps.warren.getRun(link.runId);
		if (!isTerminalRunState(run.state)) {
			if (link.workItemId !== null && workItemStatus(deps, link) === "dispatch_intent") {
				deps.store.campaigns.setWorkItemStatus(link.workItemId, "running");
			}
			results.push({
				runId: link.runId,
				workItemStatus: link.workItemId === null ? null : workItemStatus(deps, link),
				settled: false,
				costKnown: false,
			});
			continue;
		}
		results.push(settleTerminalRun(deps.store, link, run.state, run.failureReason, run.ref, run.targetBranch, run.costUsd));
	}
	return results;
}

function workItemStatus(deps: DispatchDeps, link: RunLinkRow): WorkItemStatus | null {
	if (link.workItemId === null) return null;
	const item = deps.store.campaigns.getWorkItem(link.workItemId);
	return item === null ? null : item.status;
}

/** Durable terminal settlement: facts, actual cost, final work-item state. */
function settleTerminalRun(
	store: CampaignStateStore,
	link: RunLinkRow,
	state: string,
	failureReason: string | null,
	ref: string | null,
	targetBranch: string | null,
	costUsd: number | null,
): ReconciledRun {
	const costKnown = costUsd !== null;
	return store.transaction(() => {
		const settledLink = store.events.settleRunLink(link.runId, {
			terminalState: state,
			terminalFailureReason: failureReason,
			ref,
			branch: targetBranch,
			terminalCostUsdCents: costUsd === null ? null : usdToCents(costUsd),
		});
		let workItemStatusFinal: WorkItemStatus | null = null;
		if (link.workItemId !== null) {
			const current = store.campaigns.getWorkItem(link.workItemId);
			if (current !== null && !TERMINAL_WORK_ITEM_STATUSES.has(current.status)) {
				const final: WorkItemStatus = state === "succeeded" ? "completed" : "failed";
				store.campaigns.setWorkItemStatus(link.workItemId, final);
				workItemStatusFinal = final;
			} else {
				workItemStatusFinal = current === null ? null : current.status;
			}
		}
		if (link.actionId !== null) {
			const reservation = store.budget.getActiveReservationForAction(link.actionId);
			if (reservation !== null) {
				if (costKnown) {
					store.budget.settleReservation(reservation.id, usdToCents(costUsd as number));
				} else {
					// Unknown terminal cost: keep the conservative reservation
					// and raise attention — the ledger never guesses downward.
					store.events.addAttention({
						campaignId: link.campaignId,
						workItemId: link.workItemId,
						reason: "unknown_run_cost",
						detailJson: JSON.stringify({
							runId: link.runId,
							reservationId: reservation.id,
							reservedUsdCents: reservation.amountUsdCents,
						}),
					});
				}
			}
		}
		return {
			runId: link.runId,
			workItemStatus: workItemStatusFinal,
			settled: true,
			costKnown: settledLink.terminalCostUsdCents !== null,
		};
	});
}

export interface RestartRecoverySummary {
	readonly expiredLeases: number;
	/** Known runs whose reads reconciliation can resume. */
	readonly resumedRunIds: string[];
	/** Actions whose outcome was unknown; failed closed, never re-POSTed. */
	readonly failedClosedActionIds: string[];
	/** Reservations re-created for actions that lost theirs. */
	readonly reconstructedReservationIds: string[];
}

/**
 * The boot-time sweep. Expire every lease (a restart invalidates all live
 * holders), resume known-run reads for dispatches with a correlated run,
 * fail closed into `dispatch_uncertain` + attention for any dispatch whose
 * outcome cannot be known, and reconstruct missing reservations so the
 * ledger can never under-count committed work.
 */
export function recoverFromRestart(
	store: CampaignStateStore,
	input: { nowMs: number },
): RestartRecoverySummary {
	const expiredLeases = store.leases.expireLeases();
	const resumedRunIds: string[] = [];
	const failedClosedActionIds: string[] = [];
	const reconstructedReservationIds: string[] = [];

	for (const action of store.actions.listUnfinishedActions()) {
		const link = store.events.getRunLinkForAction(action.id);
		if (link !== null) {
			// Confirmed run: resume authoritative reads; no POST may ever repeat.
			if (action.workItemId !== null) {
				store.campaigns.setWorkItemStatus(action.workItemId, "running");
			}
			resumedRunIds.push(link.runId);
			continue;
		}
		// No known run: the dispatch outcome is unknowable after a restart
		// (warren idempotency is not durable). Fail closed, never retry.
		store.transaction(() => {
			store.actions.settleAction(action.id, {
				state: "uncertain",
				errorClass: "ambiguous_response",
				errorJson: JSON.stringify({
					message: "controller restarted before the dispatch response was known",
				}),
			});
			if (action.workItemId !== null) {
				store.campaigns.setWorkItemStatus(action.workItemId, "dispatch_uncertain");
			}
			store.events.addAttention({
				campaignId: action.campaignId,
				workItemId: action.workItemId,
				reason: "restart_dispatch_uncertain",
				detailJson: JSON.stringify({
					actionKey: action.actionKey,
					idempotencyKey: action.actionKey,
					stateAtRestart: action.state,
				}),
			});
		});
		failedClosedActionIds.push(action.id);
	}

	// Reconstruct reservations: an unfinished action that owes a reservation
	// must have one, or the budget ledger under-counts committed work.
	for (const action of store.actions.listUnfinishedActions()) {
		if (action.reservedUsdCents === null) continue;
		if (store.budget.getActiveReservationForAction(action.id) !== null) continue;
		const campaign = store.campaigns.getCampaign(action.campaignId);
		if (campaign === null) continue;
		try {
			const reservation = store.budget.reserve({
				campaignId: action.campaignId,
				actionId: action.id,
				amountUsdCents: action.reservedUsdCents,
			});
			reconstructedReservationIds.push(reservation.id);
		} catch {
			store.events.addAttention({
				campaignId: action.campaignId,
				workItemId: action.workItemId,
				reason: "reservation_reconstruction_failed",
				detailJson: JSON.stringify({
					actionKey: action.actionKey,
					amountUsdCents: action.reservedUsdCents,
				}),
			});
		}
	}
	return { expiredLeases, resumedRunIds, failedClosedActionIds, reconstructedReservationIds };
}
