import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createProvider,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identifyAccount } from "../src/account.js";
import { parseConfig } from "../src/config.js";
import { parseUsagePayload } from "../src/quota.js";
import { createObservedFetch, RingRouter } from "../src/router.js";
import { StateStore } from "../src/state.js";
import { RING_DIAGNOSTIC_TYPE, type PollResult } from "../src/types.js";
import type { UsagePoller } from "../src/usage-client.js";
import { assistant, eventStream, jwt, testModel } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config() {
	return parseConfig({
		version: 1,
		providerId: "openai-codex-ring",
		accounts: [
			{ id: "a", label: "A", useBuiltinProvider: true },
			{ id: "b", label: "B" },
		],
		usagePollTtlSeconds: 60,
		usagePollTimeoutSeconds: 1,
		unknownResetRetrySeconds: 30,
	});
}

async function store(): Promise<StateStore> {
	const directory = await mkdtemp(join(tmpdir(), "codex-ring-router-"));
	temporaryDirectories.push(directory);
	const result = new StateStore(join(directory, "state.json"));
	await result.initialize();
	return result;
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

class FakeUsagePoller implements UsagePoller {
	readonly polls: string[] = [];
	closed = false;

	constructor(private readonly blockedAccounts = new Set(["account-a"])) {}

	async poll(account: Parameters<UsagePoller["poll"]>[0]): Promise<PollResult> {
		this.polls.push(account.identity.accountId);
		const blocked = this.blockedAccounts.has(account.identity.accountId);
		return {
			ok: true,
			observation: parseUsagePayload({
				plan_type: "plus",
				rate_limit: {
					allowed: !blocked,
					limit_reached: blocked,
					primary_window: {
						used_percent: blocked ? 100 : 20,
						limit_window_seconds: 18_000,
						reset_at: Math.ceil((Date.now() + 3_600_000) / 1000),
					},
				},
			}),
		};
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

type Behavior = "quota" | "partial-quota" | "auth" | "transient" | "aborted" | "success";

function provider(
	behavior: (accountId: string) => Behavior,
	attempts: string[],
) {
	const run: ProviderStreams["streamSimple"] = (
		model: Model<any>,
		_context: Context,
		options?: SimpleStreamOptions,
	) => {
		const accountId = identifyAccount(options?.apiKey ?? "").accountId;
		attempts.push(accountId);
		const selected = behavior(accountId);
		if (selected === "success") {
			const output = assistant(model as Model<"openai-codex-responses">, {
				content: [{ type: "text", text: "hello" }],
				stopReason: "stop",
			});
			return eventStream([
				{ type: "start", partial: output },
				{ type: "text_start", contentIndex: 0, partial: output },
				{ type: "text_delta", contentIndex: 0, delta: "hello", partial: output },
				{ type: "text_end", contentIndex: 0, content: "hello", partial: output },
				{ type: "done", reason: "stop", message: output },
			]);
		}
		const partial = assistant(model as Model<"openai-codex-responses">, {
			content: selected === "partial-quota" ? [{ type: "text", text: "partial" }] : [],
		});
		const aborted = selected === "aborted";
		const error = assistant(model as Model<"openai-codex-responses">, {
			content: partial.content,
			stopReason: aborted ? "aborted" : "error",
			...(aborted ? {} : {
				errorMessage: selected === "auth"
					? "Unauthorized: invalid OAuth token"
					: selected === "transient"
						? "rate_limit_exceeded: temporary request throttle"
						: "You have hit your ChatGPT usage limit.",
			}),
		});
		const events: AssistantMessageEvent[] = [{ type: "start", partial }];
		if (selected === "partial-quota") {
			events.push(
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "partial", partial },
			);
		}
		events.push({ type: "error", reason: aborted ? "aborted" : "error", error });
		return eventStream(events);
	};
	return createProvider<"openai-codex-responses">({
		id: "openai-codex",
		name: "Fake Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			apiKey: {
				name: "test",
				async resolve() {
					return { auth: { apiKey: "unused" } };
				},
			},
		},
		models: [],
		api: {
			stream: run as ProviderStreams["stream"],
			streamSimple: run,
		},
	});
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function setup(
	behavior: (accountId: string) => Behavior,
	blockedUsageAccounts = new Set(["account-a"]),
	usageOverride?: UsagePoller,
	tokens = new Map([
		["openai-codex", jwt("account-a")],
		["openai-codex-ring-auth-b", jwt("account-b")],
	]),
) {
	const attempts: string[] = [];
	const usage = usageOverride ?? new FakeUsagePoller(blockedUsageAccounts);
	const state = await store();
	const onSwitch = vi.fn();
	const router = new RingRouter(config(), state, { onSwitch }, {
		usageClient: usage,
		baseProvider: provider(behavior, attempts),
	});
	router.bindRegistry(registry(tokens));
	router.startSession();
	return { router, attempts, usage, state, onSwitch };
}

describe("observed provider fetch", () => {
	it("captures structured errors without consuming the adapter's response body", async () => {
		const capture: Parameters<typeof createObservedFetch>[1] = {};
		const observed = createObservedFetch(
			async () =>
				new Response(
					JSON.stringify({ error: { code: "usage_limit_reached", message: "window exhausted", resets_at: 2_000_000_000 } }),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"x-codex-primary-used-percent": "100",
							"x-codex-primary-window-minutes": "300",
						},
					},
				),
			capture,
			() => undefined,
		);
		const response = await observed("https://example.test");
		expect(capture.httpError).toMatchObject({ status: 429, code: "usage_limit_reached" });
		expect(capture.lastHeaderObservation?.limits[0]?.primary?.kind).toBe("five_hour");
		expect(await response.json()).toMatchObject({ error: { code: "usage_limit_reached" } });
	});
});

describe("ring stream routing", () => {
	it("stays sticky on success and advances cyclically only when requested", async () => {
		const fixture = await setup(() => "success", new Set());
		await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a", "account-a"]);
		expect(fixture.router.next()).toBe("b");
		await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a", "account-a", "account-b"]);
		await fixture.router.shutdown();
	});

	it("detects duplicate logins and does not count them as extra capacity", async () => {
		const duplicateTokens = new Map([
			["openai-codex", jwt("account-a")],
			["openai-codex-ring-auth-b", jwt("account-a")],
		]);
		const fixture = await setup(() => "success", new Set(), undefined, duplicateTokens);
		await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a"]);
		expect(fixture.router.statusRows().find((row) => row.id === "b")?.duplicateOf).toBe("a");
		await fixture.router.shutdown();
	});

	it("treats an unauthorized private usage endpoint as stale telemetry and probes the model", async () => {
		const usage: UsagePoller = {
			async poll() {
				return { ok: false, kind: "unauthorized", status: 403, message: "unavailable" };
			},
			async close() {},
		};
		const fixture = await setup(() => "success", new Set(), usage);
		const fingerprint = identifyAccount(jwt("account-a")).fingerprint;
		await fixture.state.setHardStop("a", fingerprint, {
			kind: "usage_limit",
			observedAt: Date.now() - 60_000,
			resetAt: Date.now() - 1,
			exhaustedWindows: [],
		});
		const events = await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a"]);
		expect(events.at(-1)?.type).toBe("done");
		await fixture.router.shutdown();
	});

	it("discards a pre-output quota failure and completes the same turn on the next account", async () => {
		const fixture = await setup((accountId) => (accountId === "account-a" ? "quota" : "success"));
		const events = await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a", "account-b"]);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("done");
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.message.provider).toBe("openai-codex-ring");
		expect(done.message.diagnostics?.find((entry) => entry.type === RING_DIAGNOSTIC_TYPE)?.details).toMatchObject({
			accountSlotId: "b",
			attempt: 2,
		});
		expect(fixture.onSwitch).toHaveBeenCalledTimes(1);
		const aFingerprint = identifyAccount(jwt("account-a")).fingerprint;
		expect(fixture.state.snapshot().accounts[aFingerprint]?.hardStop?.kind).toMatch(/usage_limit|endpoint_hard_stop/);
		await fixture.router.shutdown();
	});

	it("does not rotate on a transient rate limit or an abort", async () => {
		const transient = await setup(() => "transient", new Set());
		const transientEvents = await collect(transient.router.streamSimple(testModel, { messages: [] }));
		expect(transient.attempts).toEqual(["account-a"]);
		expect(transientEvents.at(-1)?.type).toBe("error");
		await transient.router.shutdown();

		const aborted = await setup(() => "aborted", new Set());
		const abortedEvents = await collect(aborted.router.streamSimple(testModel, { messages: [] }));
		expect(aborted.attempts).toEqual(["account-a"]);
		expect(abortedEvents.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
		await aborted.router.shutdown();
	});

	it("honors forced mode without automatic failover", async () => {
		const fixture = await setup((accountId) => accountId === "account-a" ? "quota" : "success");
		expect(fixture.router.forceAccount("a")).toBe(true);
		const events = await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a"]);
		expect(events.at(-1)?.type).toBe("error");
		await fixture.router.shutdown();
	});

	it("never retries after user-visible output", async () => {
		const fixture = await setup((accountId) => (accountId === "account-a" ? "partial-quota" : "success"));
		const events = await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a"]);
		expect(events.some((event) => event.type === "text_delta" && event.delta === "partial")).toBe(true);
		expect(events.at(-1)?.type).toBe("error");
		await fixture.router.shutdown();
	});

	it("fails over on pre-output authentication rejection", async () => {
		const fixture = await setup((accountId) => (accountId === "account-a" ? "auth" : "success"));
		const events = await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a", "account-b"]);
		expect(events.at(-1)?.type).toBe("done");
		expect(fixture.router.statusRows().find((row) => row.id === "a")?.authError).toContain("rejected");
		await fixture.router.shutdown();
	});

	it("attempts each account once and emits one terminal error when all are exhausted", async () => {
		const fixture = await setup(() => "quota");
		const events = await collect(fixture.router.streamSimple(testModel, { messages: [] }));
		expect(fixture.attempts).toEqual(["account-a", "account-b"]);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		const error = events.at(-1);
		if (error?.type !== "error") throw new Error("expected error");
		expect(error.error.errorMessage).toContain("All Codex ring accounts are unavailable");
		await fixture.router.shutdown();
	});
});
