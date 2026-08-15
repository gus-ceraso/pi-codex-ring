import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, defaultConfig, loadConfig, parseConfig } from "../src/config.js";
import { AUTH_PROVIDER_PREFIX } from "../src/types.js";

describe("config", () => {
	it("provides a one-account safe default", () => {
		const config = defaultConfig();
		expect(config.accounts).toHaveLength(1);
		expect(config.accounts[0]).toMatchObject({
			id: "primary",
			authProviderId: "openai-codex",
			useBuiltinProvider: true,
		});
	});

	it("derives independent auth provider IDs and defaults", () => {
		const config = parseConfig({
			version: 1,
			providerId: "openai-codex-ring",
			unknownFutureField: true,
			accounts: [
				{ id: "main", label: "Main", useBuiltinProvider: true },
				{ id: "work_2", label: "Work", enabled: false },
			],
		});
		expect(config.accounts[0]?.authProviderId).toBe("openai-codex");
		expect(config.accounts[1]).toMatchObject({
			authProviderId: `${AUTH_PROVIDER_PREFIX}work_2`,
			enabled: false,
		});
		expect(config.usagePollTtlMs).toBe(60_000);
	});

	it("restricts a loaded configuration file to mode 0600", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codex-ring-config-"));
		const path = join(directory, CONFIG_FILE_NAME);
		try {
			await writeFile(path, JSON.stringify({ version: 1, accounts: [{ id: "a", label: "A" }] }), { mode: 0o644 });
			const loaded = await loadConfig(directory);
			expect(loaded.exists).toBe(true);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[{ version: 2, accounts: [{ id: "a", label: "A" }] }, "version"],
		[{ version: 1, accounts: [] }, "accounts"],
		[{ version: 1, accounts: [{ id: "Bad ID", label: "A" }] }, "must match"],
		[
			{
				version: 1,
				accounts: [
					{ id: "a", label: "A", useBuiltinProvider: true },
					{ id: "b", label: "B", useBuiltinProvider: true },
				],
			},
			"duplicate or colliding provider",
		],
		[
			{
				version: 1,
				accounts: [
					{ id: "a", label: "A" },
					{ id: "a", label: "B" },
				],
			},
			"duplicate account",
		],
	])("rejects invalid configuration %#", (value, message) => {
		expect(() => parseConfig(value)).toThrow(message);
	});
});
