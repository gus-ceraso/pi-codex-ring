import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identifyAccount } from "../src/account.js";
import { parseConfig } from "../src/config.js";
import { parseUsagePayload } from "../src/quota.js";
import { RingRouter, type AccountOperationFailure } from "../src/router.js";
import { StateStore } from "../src/state.js";
import type { PollResult } from "../src/types.js";
import type { UsagePoller } from "../src/usage-client.js";
import { jwt } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config() {
	return parseConfig({
		version: 1,
		providerId: "openai-codex-ring",
		accounts: [
			{ id: "a", label: "A", useBuiltinProvider: true },
			{ id: "b", label: "B" },
		],
		usagePollTimeoutSeconds: 1,
		unknownResetRetrySeconds: 30,
	});
}

function registry(tokens: Map<string, string>): ModelRegistry {
	return {
		getProviderAuthStatus(providerId: string) {
			return { configured: tokens.has(providerId), source: "stored" as const };
		},
		async getProviderAuth(providerId: string) {
			const apiKey = tokens.get(providerId);
			return apiKey ? { auth: { apiKey }, source: "test" } : undefined;
		},
	} as unknown as ModelRegistry;
}

class AvailableUsage implements UsagePoller {
	async poll(): Promise<PollResult> {
		return {
			ok: true,
			observation: parseUsagePayload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
				},
				additional_rate_limits: [{
					metered_feature: "image_gen",
					rate_limit: { allowed: true, limit_reached: false },
				}],
			}),
		};
	}

	async close(): Promise<void> {}
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "codex-ring-image-router-"));
	directories.push(directory);
	const store = new StateStore(join(directory, "state.json"));
	await store.initialize();
	const onSwitch = vi.fn();
	const router = new RingRouter(config(), store, { onSwitch }, { usageClient: new AvailableUsage() });
	router.bindRegistry(registry(new Map([
		["openai-codex", jwt("account-a")],
		["openai-codex-ring-auth-b", jwt("account-b")],
	])));
	router.startSession();
	return { router, store, onSwitch };
}

describe("ring account operations", () => {
	it("rotates on authoritative image exhaustion and stores an image-only block", async () => {
		const { router, store, onSwitch } = await setup();
		const attempts: string[] = [];
		const result = await router.runAccountOperation({
			resourceId: "image_gen",
			async execute(account) {
				attempts.push(account.identity.accountId);
				if (account.identity.accountId === "account-a") throw new Error("exhausted");
				return "image";
			},
			classify(): AccountOperationFailure {
				return { kind: "usage_limit", limitId: "image_gen", reason: "image allowance exhausted" };
			},
		});
		expect(result).toBe("image");
		expect(attempts).toEqual(["account-a", "account-b"]);
		expect(onSwitch).toHaveBeenCalledTimes(1);
		const fingerprint = identifyAccount(jwt("account-a")).fingerprint;
		const state = store.snapshot().accounts[fingerprint];
		expect(state?.hardStop).toBeUndefined();
		expect(state?.modelBlocks.image_gen).toMatchObject({
			kind: "usage_limit",
			modelId: "image_gen",
			limitId: "image_gen",
		});
		await router.shutdown();
	});

	it("does not replay ambiguous failures", async () => {
		const { router } = await setup();
		const attempts: string[] = [];
		await expect(router.runAccountOperation({
			resourceId: "image_gen",
			async execute(account) {
				attempts.push(account.identity.accountId);
				throw new Error("connection reset");
			},
			classify: () => ({ kind: "other" }),
		})).rejects.toThrow("connection reset");
		expect(attempts).toEqual(["account-a"]);
		await router.shutdown();
	});

	it("records but does not rotate a forced account", async () => {
		const { router } = await setup();
		expect(router.forceAccount("a")).toBe(true);
		const attempts: string[] = [];
		await expect(router.runAccountOperation({
			resourceId: "image_gen",
			async execute(account) {
				attempts.push(account.identity.accountId);
				throw new Error("exhausted");
			},
			classify: () => ({ kind: "usage_limit", limitId: "image_gen" }),
		})).rejects.toThrow("exhausted");
		expect(attempts).toEqual(["account-a"]);
		await router.shutdown();
	});
});
