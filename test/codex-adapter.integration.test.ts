import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { RingRouter } from "../src/router.js";
import { StateStore } from "../src/state.js";
import { jwt, testModel } from "./helpers.js";

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

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("built-in Codex adapter integration", () => {
	it("fails over from a real pre-output HTTP/SSE quota response", async () => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			const account = String(request.headers["chatgpt-account-id"] ?? "none");
			requests.push(`${request.method} ${request.url} ${account}`);
			request.resume();
			if (request.url === "/api/codex/usage") {
				const blocked = account === "account-a";
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					rate_limit: {
						allowed: !blocked,
						limit_reached: blocked,
						primary_window: {
							used_percent: blocked ? 100 : 20,
							limit_window_seconds: 18_000,
							reset_at: Math.ceil((Date.now() + 3_600_000) / 1000),
						},
					},
				}));
				return;
			}
			if (request.url === "/codex/responses" && account === "account-a") {
				response.writeHead(429, {
					"content-type": "application/json",
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
				});
				response.end(JSON.stringify({ error: {
					type: "usage_limit_reached",
					message: "five-hour window exhausted",
					resets_at: Math.ceil((Date.now() + 3_600_000) / 1000),
				} }));
				return;
			}
			if (request.url === "/codex/responses" && account === "account-b") {
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				const item = {
					type: "message",
					id: "msg_b",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok from b", annotations: [] }],
				};
				const events = [
					{ type: "response.created", response: { id: "resp_b", status: "in_progress" } },
					{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok from b" },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: {
						id: "resp_b",
						status: "completed",
						output: [item],
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					} },
				];
				for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
				response.end();
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing test server address");
		const directory = await mkdtemp(join(tmpdir(), "codex-ring-adapter-"));
		const statePath = join(directory, "state.json");
		const store = new StateStore(statePath);
		await store.initialize();
		const config = parseConfig({
			version: 1,
			accounts: [
				{ id: "a", label: "A", useBuiltinProvider: true },
				{ id: "b", label: "B" },
			],
			usagePollTimeoutSeconds: 2,
		});
		const router = new RingRouter(config, store);
		router.bindRegistry(registry(new Map([
			["openai-codex", jwt("account-a")],
			["openai-codex-ring-auth-b", jwt("account-b")],
		])));
		router.startSession();
		try {
			let fetchCalls = 0;
			let payloadCalls = 0;
			let responseCalls = 0;
			const model: Model<"openai-codex-responses"> = {
				...testModel,
				baseUrl: `http://127.0.0.1:${address.port}`,
			};
			const events = await collect(router.streamSimple(model, { messages: [] }, {
				transport: "sse",
				async fetch(input, init) {
					fetchCalls++;
					return globalThis.fetch(input, init);
				},
				onPayload() {
					payloadCalls++;
				},
				onResponse() {
					responseCalls++;
				},
			}));
			const done = events.at(-1);
			expect(done?.type).toBe("done");
			if (done?.type !== "done") throw new Error("expected completed response");
			expect(done.message.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok from b" }));
			expect({ fetchCalls, payloadCalls, responseCalls }).toEqual({
				fetchCalls: 2,
				payloadCalls: 2,
				responseCalls: 2,
			});
			expect(requests).toEqual(expect.arrayContaining([
				"POST /codex/responses account-a",
				"GET /api/codex/usage account-a",
				"POST /codex/responses account-b",
			]));
			const persisted = await readFile(statePath, "utf8");
			expect(persisted).not.toContain("account-a");
			expect(persisted).not.toContain("account-b");
			expect(persisted).not.toContain(jwt("account-a"));
		} finally {
			await router.shutdown();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
