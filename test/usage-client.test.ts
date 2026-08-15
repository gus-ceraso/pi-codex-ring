import { describe, expect, it, vi } from "vitest";
import { identifyAccount } from "../src/account.js";
import type { ResolvedAccount } from "../src/types.js";
import { resolveUsageUrl, UsageClient, type UsageFetch } from "../src/usage-client.js";
import { jwt } from "./helpers.js";

function account(): ResolvedAccount {
	const apiKey = jwt("account-a");
	return {
		slot: {
			id: "primary",
			label: "Primary",
			enabled: true,
			useBuiltinProvider: true,
			authProviderId: "openai-codex",
		},
		index: 0,
		auth: { auth: { apiKey }, source: "test" },
		apiKey,
		identity: identifyAccount(apiKey),
	};
}

describe("usage client", () => {
	it("selects official usage paths", () => {
		expect(resolveUsageUrl("https://chatgpt.com/backend-api")).toBe(
			"https://chatgpt.com/backend-api/wham/usage",
		);
		expect(resolveUsageUrl("https://chatgpt.com")).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(resolveUsageUrl("https://codex.example/v1")).toBe("https://codex.example/v1/api/codex/usage");
	});

	it("authenticates and parses a usage response", async () => {
		const fetchImpl = vi.fn<UsageFetch>(async (_url, init) => {
			const headers = new Headers(init.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${account().apiKey}`);
			expect(headers.get("chatgpt-account-id")).toBe("account-a");
			return new Response(
				JSON.stringify({
					plan_type: "plus",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const client = new UsageClient(1_000, fetchImpl);
		const result = await client.poll(account(), "https://chatgpt.com/backend-api");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.observation.limits[0]?.primary?.kind).toBe("five_hour");
		await client.close();
	});

	it("does not treat endpoint throttling as account exhaustion", async () => {
		const client = new UsageClient(1_000, async () => new Response("busy", { status: 429 }));
		expect(await client.poll(account(), "https://chatgpt.com/backend-api")).toMatchObject({
			ok: false,
			kind: "http",
			status: 429,
		});
	});
});
