import { describe, expect, it, vi } from "vitest";
import { identifyAccount } from "../src/account.js";
import {
	ImagesClient,
	ImageRequestError,
	resolveImagesUrl,
	type ImageFetch,
} from "../src/images-client.js";
import type { ResolvedAccount } from "../src/types.js";
import { jwt } from "./helpers.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function account(): ResolvedAccount {
	const apiKey = jwt("account-a");
	return {
		slot: {
			id: "a",
			label: "A",
			enabled: true,
			useBuiltinProvider: true,
			authProviderId: "openai-codex",
		},
		index: 0,
		auth: {
			auth: {
				apiKey,
				headers: {
					"X-Provider": "kept",
					Authorization: "Bearer wrong",
					"ChatGPT-Account-ID": "wrong-account",
				},
			},
			source: "test",
		},
		apiKey,
		identity: identifyAccount(apiKey),
	};
}

describe("Codex images client", () => {
	it("normalizes ChatGPT and Codex endpoint URLs", () => {
		expect(resolveImagesUrl("https://chatgpt.com/backend-api", false))
			.toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(resolveImagesUrl("https://chatgpt.com/backend-api/codex/", true))
			.toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(resolveImagesUrl("https://example.test/api/codex", false))
			.toBe("https://example.test/api/codex/images/generations");
	});

	it("sends the fixed generation contract with authoritative account headers", async () => {
		const fetch = vi.fn<ImageFetch>(async (_url, _init) => new Response(JSON.stringify({
			created: 1,
			background: "transparent",
			quality: "high",
			size: "1024x1024",
			data: [{ b64_json: PNG_BASE64 }],
		}), {
			status: 200,
			headers: { "x-codex-imagegen-request-id": "request-1" },
		}));
		const client = new ImagesClient(fetch, 1_000);
		const result = await client.request(account(), "https://chatgpt.com/backend-api", { prompt: "fox" });
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${account().apiKey}`);
		expect(headers.get("chatgpt-account-id")).toBe("account-a");
		expect(headers.get("x-provider")).toBe("kept");
		expect(JSON.parse(String(init?.body))).toEqual({
			prompt: "fox",
			background: "auto",
			model: "gpt-image-2",
			quality: "auto",
			size: "auto",
		});
		expect(result.base64).toBe(PNG_BASE64);
		expect(result.metadata).toEqual({
			background: "transparent",
			quality: "high",
			size: "1024x1024",
			requestId: "request-1",
		});
	});

	it("sends edit images as image_url objects", async () => {
		const fetch = vi.fn<ImageFetch>(async () => new Response(JSON.stringify({
			created: 1,
			data: [{ b64_json: PNG_BASE64 }],
		}), { status: 200 }));
		const client = new ImagesClient(fetch, 1_000);
		await client.request(account(), "https://chatgpt.com/backend-api", {
			prompt: "add a hat",
			images: ["data:image/png;base64,AAAA"],
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toContain("/images/edits");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			images: [{ image_url: "data:image/png;base64,AAAA" }],
			prompt: "add a hat",
		});
	});

	it("captures bounded structured HTTP failures", async () => {
		const client = new ImagesClient(async () => new Response(JSON.stringify({
			error: {
				code: "usage_limit_reached",
				message: "image allowance exhausted",
				resets_at: 2_000_000_000,
			},
		}), {
			status: 429,
			headers: { "x-codex-active-limit": "image_gen" },
		}), 1_000);
		const error = await client.request(account(), "https://chatgpt.com/backend-api", { prompt: "fox" })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(ImageRequestError);
		expect(error).toMatchObject({
			kind: "http",
			captured: {
				status: 429,
				code: "usage_limit_reached",
				activeLimit: "image_gen",
			},
		});
	});

	it("rejects invalid base64 and non-PNG successful responses", async () => {
		const invalid = new ImagesClient(async () => new Response(JSON.stringify({
			data: [{ b64_json: "not base64" }],
		}), { status: 200 }), 1_000);
		await expect(invalid.request(account(), "https://chatgpt.com/backend-api", { prompt: "x" }))
			.rejects.toMatchObject({ kind: "invalid_response" });

		const nonPng = new ImagesClient(async () => new Response(JSON.stringify({
			data: [{ b64_json: Buffer.from("hello").toString("base64") }],
		}), { status: 200 }), 1_000);
		await expect(nonPng.request(account(), "https://chatgpt.com/backend-api", { prompt: "x" }))
			.rejects.toThrow("non-PNG");
	});
});
