import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_BIND_HOST,
	DEFAULT_BIND_PORT,
	DEFAULT_DATA_DIR,
	loadServerConfigFromEnv,
	resolveDefaultUiDistDir,
} from "./config.ts";

describe("loadServerConfigFromEnv", () => {
	test("defaults to TCP on 0.0.0.0:8080 with /data + warren.db", () => {
		const config = loadServerConfigFromEnv({ env: { WARREN_API_TOKEN: "x" } });
		expect(config.transport.kind).toBe("tcp");
		if (config.transport.kind === "tcp") {
			expect(config.transport.hostname).toBe(DEFAULT_BIND_HOST);
			expect(config.transport.port).toBe(DEFAULT_BIND_PORT);
		}
		expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
		expect(config.dbUrl).toBe("sqlite:///data/warren.db");
		expect(config.dbUrlConflict).toBeNull();
		expect(config.token).toBe("x");
	});

	test("WARREN_BIND_SOCKET wins over host/port", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_BIND_SOCKET: "/tmp/warren.sock",
				WARREN_BIND_PORT: "9000",
			},
		});
		expect(config.transport.kind).toBe("unix");
		if (config.transport.kind === "unix") {
			expect(config.transport.path).toBe("/tmp/warren.sock");
		}
	});

	test("custom data dir threads through to db url", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DATA_DIR: "/var/lib/warren" },
		});
		expect(config.dataDir).toBe("/var/lib/warren");
		expect(config.dbUrl).toBe("sqlite:///var/lib/warren/warren.db");
	});

	test("WARREN_DB_PATH synthesizes a sqlite:// url (back-compat)", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DB_PATH: "/srv/warren.sqlite" },
		});
		expect(config.dbUrl).toBe("sqlite:///srv/warren.sqlite");
		expect(config.dbUrlConflict).toBeNull();
	});

	test("WARREN_DB_URL wins over WARREN_DB_PATH (sqlite)", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_DB_URL: "sqlite:///srv/warren.sqlite",
				WARREN_DB_PATH: "/srv/warren.sqlite",
			},
		});
		expect(config.dbUrl).toBe("sqlite:///srv/warren.sqlite");
		expect(config.dbUrlConflict).toBeNull();
	});

	test("WARREN_DB_URL=postgres:// passes through unchanged", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_DB_URL: "postgres://u:p@host:5432/db",
			},
		});
		expect(config.dbUrl).toBe("postgres://u:p@host:5432/db");
	});

	test("conflicting WARREN_DB_URL + WARREN_DB_PATH surfaces dbUrlConflict", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_DB_URL: "postgres://u:p@host/db",
				WARREN_DB_PATH: "/srv/legacy.sqlite",
			},
		});
		expect(config.dbUrl).toBe("postgres://u:p@host/db");
		expect(config.dbUrlConflict).toBe("/srv/legacy.sqlite");
	});

	test("WARREN_DISABLE_UI accepts 1/true/yes/on (case- and whitespace-insensitive)", () => {
		for (const raw of ["1", "true", "On", "YES", " true "]) {
			const config = loadServerConfigFromEnv({
				env: { WARREN_API_TOKEN: "x", WARREN_DISABLE_UI: raw },
			});
			expect(config.uiDistDir).toBeNull();
		}
	});

	test("WARREN_DISABLE_UI leaves UI enabled for empty / 0 / off", () => {
		for (const raw of ["", "0", "off"]) {
			const config = loadServerConfigFromEnv({
				env: { WARREN_API_TOKEN: "x", WARREN_DISABLE_UI: raw, WARREN_UI_DIST_DIR: "/app/ui" },
			});
			expect(config.uiDistDir).toBe("/app/ui");
		}
	});

	test("WARREN_UI_DIST_DIR overrides the default", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_UI_DIST_DIR: "/app/ui" },
		});
		expect(config.uiDistDir).toBe("/app/ui");
	});

	test("noAuth=true returns token=null without checking env", () => {
		const config = loadServerConfigFromEnv({ env: {}, noAuth: true });
		expect(config.token).toBeNull();
	});

	test("missing WARREN_API_TOKEN throws when noAuth=false", () => {
		expect(() => loadServerConfigFromEnv({ env: {} })).toThrow(ValidationError);
	});

	test("invalid port throws", () => {
		expect(() =>
			loadServerConfigFromEnv({ env: { WARREN_API_TOKEN: "x", WARREN_BIND_PORT: "70000" } }),
		).toThrow(ValidationError);
	});
});

describe("resolveDefaultUiDistDir", () => {
	test("prefers the cwd layout when src/ui/dist exists there", () => {
		const root = mkdtempSync(join(tmpdir(), "warren-ui-cwd-"));
		const other = mkdtempSync(join(tmpdir(), "warren-ui-other-"));
		try {
			mkdirSync(join(root, "src", "ui", "dist"), { recursive: true });
			expect(resolveDefaultUiDistDir(root, other)).toBe(join(root, "src", "ui", "dist"));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

	test("falls back to the module-relative npm layout when cwd has no dist", () => {
		const cwd = mkdtempSync(join(tmpdir(), "warren-ui-empty-cwd-"));
		const pkgRoot = mkdtempSync(join(tmpdir(), "warren-ui-pkg-"));
		try {
			// moduleDir plays src/server: dist sits at <pkgRoot>/src/ui/dist.
			const moduleDir = join(pkgRoot, "src", "server");
			mkdirSync(join(pkgRoot, "src", "ui", "dist"), { recursive: true });
			expect(resolveDefaultUiDistDir(cwd, moduleDir)).toBe(join(pkgRoot, "src", "ui", "dist"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(pkgRoot, { recursive: true, force: true });
		}
	});

	test("returns the cwd layout when neither exists (useful default for logs)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "warren-ui-none-"));
		const pkgRoot = mkdtempSync(join(tmpdir(), "warren-ui-none-pkg-"));
		try {
			expect(resolveDefaultUiDistDir(cwd, join(pkgRoot, "src", "server"))).toBe(
				join(cwd, "src", "ui", "dist"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(pkgRoot, { recursive: true, force: true });
		}
	});
});
