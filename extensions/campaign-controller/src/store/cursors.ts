/**
 * Reconciliation cursor store (warren-323d).
 *
 * Polling is at-least-once: pages can arrive reordered, a restart replays
 * from scratch, and GitHub serves the same facts twice. The reconciler
 * therefore persists one JSON cursor per polled resource — conditional
 * validators (ETag / Last-Modified) plus the last observed snapshot facts —
 * so a restart resumes where the previous tick stopped and an unchanged
 * upstream costs a 304, not a re-ingestion.
 */

import type { StoreContext } from "./context.ts";

type CursorDbRow = {
	key: string;
	value_json: string;
	updated_at_ms: number;
};

export class CursorStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	/** Read one cursor's persisted value, or null when never polled. */
	get<T>(key: string): T | null {
		const row = this.#ctx.db
			.query("SELECT * FROM poll_cursors WHERE key = ?")
			.get(key) as CursorDbRow | null;
		if (row === null) {
			return null;
		}
		return JSON.parse(row.value_json) as T;
	}

	/** Upsert one cursor's value (JSON-serialized) with a fresh timestamp. */
	set(key: string, value: unknown): void {
		this.#ctx.db
			.query(
				`INSERT INTO poll_cursors (key, value_json, updated_at_ms)
				 VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
				 updated_at_ms = excluded.updated_at_ms`,
			)
			.run(key, JSON.stringify(value), this.#ctx.clock.nowMs());
	}
}
