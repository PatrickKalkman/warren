/**
 * Durable reconciliation cursors (warren-323d).
 *
 * A cursor marks where the read-only upstream reconciler last completed a
 * full reconciliation of one scope (e.g. one upstream PR). It survives
 * controller restart, so a rebooted controller resumes polling instead of
 * replaying already-ingested history — and because event ingestion itself
 * is deduplicated by node id, a cursor replayed from zero is still safe,
 * merely more expensive.
 */
import { nowMs, type StoreContext } from "./context.ts";
import type { PollCursorRow } from "./types.ts";

type CursorDbRow = {
	scope: string;
	checkpoint_json: string;
	updated_at_ms: number;
};

function toCursor(row: CursorDbRow): PollCursorRow {
	return {
		scope: row.scope,
		checkpointJson: row.checkpoint_json,
		updatedAtMs: row.updated_at_ms,
	};
}

export class CursorStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	/** Load the cursor for `scope`, or null when none was ever written. */
	getCursor(scope: string): PollCursorRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM poll_cursors WHERE scope = ?")
			.get(scope) as CursorDbRow | null;
		return row === null ? null : toCursor(row);
	}

	/** Persist (upsert) the cursor checkpoint for `scope`. */
	setCursor(scope: string, checkpointJson: string): PollCursorRow {
		this.#ctx.db
			.query(
				`INSERT INTO poll_cursors (scope, checkpoint_json, updated_at_ms)
				 VALUES (?, ?, ?)
				 ON CONFLICT(scope) DO UPDATE SET checkpoint_json = excluded.checkpoint_json,
				 updated_at_ms = excluded.updated_at_ms`,
			)
			.run(scope, checkpointJson, nowMs(this.#ctx));
		const row = this.getCursor(scope);
		if (row === null) {
			throw new Error(`cursor write for scope ${scope} did not persist`);
		}
		return row;
	}

	/** Every cursor scope, for restart-time enumeration. */
	listScopes(): string[] {
		const rows = this.#ctx.db
			.query("SELECT scope FROM poll_cursors ORDER BY scope")
			.all() as Array<{
			scope: string;
		}>;
		return rows.map((row) => row.scope);
	}
}
