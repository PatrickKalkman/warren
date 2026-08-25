import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { CampaignStateStore } from "./state-store.ts";

const clock = new FixedClock(1_000_000);

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "campaign-cursors-"));
	dbPath = join(dir, "state.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("CursorStore", () => {
	test("a cursor round-trips and updates in place", () => {
		const store = new CampaignStateStore(dbPath, { clock, ids: new SequentialIdGenerator() });
		expect(store.cursors.getCursor("pr-reconcile:openclaw/openclaw#7")).toBeNull();
		store.cursors.setCursor("pr-reconcile:openclaw/openclaw#7", '{"outcome":"reconciled"}');
		clock.advance(1_000);
		store.cursors.setCursor("pr-reconcile:openclaw/openclaw#7", '{"outcome":"second"}');
		const cursor = store.cursors.getCursor("pr-reconcile:openclaw/openclaw#7");
		expect(cursor?.checkpointJson).toBe('{"outcome":"second"}');
		expect(cursor?.updatedAtMs).toBe(1_001_000);
		expect(store.cursors.listScopes()).toEqual(["pr-reconcile:openclaw/openclaw#7"]);
		store.close();
	});

	test("a cursor survives a store reopen (restart recovery)", () => {
		const store = new CampaignStateStore(dbPath, { clock, ids: new SequentialIdGenerator() });
		store.cursors.setCursor("scope-a", '{"lastCompletedAtMs":1}');
		store.close();

		const reopened = new CampaignStateStore(dbPath, {
			clock,
			ids: new SequentialIdGenerator(),
		});
		expect(reopened.cursors.getCursor("scope-a")?.checkpointJson).toBe('{"lastCompletedAtMs":1}');
		expect(reopened.cursors.listScopes()).toEqual(["scope-a"]);
		reopened.close();
	});
});
