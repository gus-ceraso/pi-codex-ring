import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHardStop, parseUsagePayload } from "../src/quota.js";
import { accountAvailability, mergeObservation, StateStore } from "../src/state.js";
import { emptyAccountState } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryState(): Promise<StateStore> {
	const directory = await mkdtemp(join(tmpdir(), "codex-ring-state-"));
	temporaryDirectories.push(directory);
	const store = new StateStore(join(directory, "state.json"));
	await store.initialize();
	return store;
}

describe("quota state", () => {
	it("waits for the latest exhausted window and then requires a probe", () => {
		const now = 1_000_000;
		const observation = parseUsagePayload(
			{
				rate_limit: {
					allowed: false,
					limit_reached: true,
					primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: 2_000 },
					secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 3_000 },
				},
			},
			now,
		);
		const account = mergeObservation(emptyAccountState("a".repeat(24)), observation, {
			allowClear: false,
			recordHardStop: true,
		});
		expect(account.hardStop?.resetAt).toBe(3_000_000);
		expect(accountAvailability(account, "model", 2_500_000, 300_000).kind).toBe("blocked");
		expect(accountAvailability(account, "model", 3_000_001, 300_000).kind).toBe("probe_needed");
	});

	it("does not let stale observations clear a newer hard stop", () => {
		const fingerprint = "b".repeat(24);
		const account = emptyAccountState(fingerprint);
		account.hardStop = buildHardStop(undefined, {
			kind: "usage_limit",
			observedAt: 500,
			resetAt: 1_000,
		});
		account.lastObservedAt = 500;
		const stale = parseUsagePayload({ rate_limit: { allowed: true, limit_reached: false } }, 400);
		const merged = mergeObservation(account, stale, { allowClear: true, recordHardStop: true });
		expect(merged.hardStop).toEqual(account.hardStop);
	});

	it("clears a reset stop only after a newer endpoint availability result", () => {
		const fingerprint = "c".repeat(24);
		const account = emptyAccountState(fingerprint);
		account.hardStop = buildHardStop(undefined, { kind: "usage_limit", observedAt: 500, resetAt: 600 });
		const available = parseUsagePayload({ rate_limit: { allowed: true, limit_reached: false } }, 700);
		const merged = mergeObservation(account, available, { allowClear: true, recordHardStop: true });
		expect(merged.hardStop).toBeUndefined();
	});
});

describe("StateStore", () => {
	it("persists atomically with private permissions and clears cooldowns", async () => {
		const store = await temporaryState();
		const fingerprint = "d".repeat(24);
		await store.rememberAccount("primary", fingerprint, 100);
		await store.setHardStop(
			"primary",
			fingerprint,
			buildHardStop(undefined, { kind: "usage_limit", observedAt: 100, resetAt: 200 }),
		);
		expect(store.snapshot().accounts[fingerprint]?.hardStop).toBeDefined();
		expect(await store.clearForSlot("primary")).toBe(true);
		expect(store.snapshot().accounts[fingerprint]?.hardStop).toBeUndefined();
		expect((await stat(store.path)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({ version: 1 });
	});

	it("quarantines corrupt state without blocking startup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codex-ring-state-corrupt-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "state.json");
		await writeFile(path, "contains a fake eyJ.token.value", { mode: 0o644 });
		const store = new StateStore(path);
		await store.initialize();
		expect(store.warnings).toHaveLength(1);
		expect(store.snapshot()).toMatchObject({ version: 1, accounts: {}, slots: {} });
		const quarantined = (await readdir(directory)).find((name) => name.startsWith("state.json.corrupt-"));
		expect(quarantined).toBeDefined();
		if (quarantined) expect((await stat(join(directory, quarantined))).mode & 0o777).toBe(0o600);
	});

	it("merges updates from independent store instances under a cross-process lock", async () => {
		const first = await temporaryState();
		const second = new StateStore(first.path);
		await second.initialize();
		await Promise.all([
			first.rememberAccount("one", "1".repeat(24), 100),
			second.rememberAccount("two", "2".repeat(24), 200),
		]);
		const snapshot = await first.refresh();
		expect(snapshot.slots.one?.fingerprint).toBe("1".repeat(24));
		expect(snapshot.slots.two?.fingerprint).toBe("2".repeat(24));
	});
});
