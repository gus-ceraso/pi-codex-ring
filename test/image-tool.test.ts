import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageTool, classifyImageFailure } from "../src/image-tool.js";
import { ImageRequestError, type GeneratedImage, type ImagesClient } from "../src/images-client.js";
import type { AccountOperation, RingRouter } from "../src/router.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(cwd: string): ExtensionContext {
	return {
		hasUI: false,
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "session-1",
			buildContextEntries: () => [],
		},
	} as unknown as ExtensionContext;
}

describe("image tool", () => {
	it("exposes the approved strict model interface", () => {
		const tool = createImageTool({} as RingRouter, {} as ImagesClient, "/agent");
		expect(tool.name).toBe("image_gen");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.parameters).toMatchObject({
			type: "object",
			required: ["prompt"],
			properties: {
				model: {
					type: "string",
					enum: [
						"gpt-image-2.5-flare-2026-09-08",
						"gpt-image-2.5-sunburst-2026-09-08",
						"gpt-image-2-2026-04-21",
					],
					default: "gpt-image-2.5-flare-2026-09-08",
				},
			},
			additionalProperties: false,
		});
	});

	it("returns and saves the generated image without duplicating base64 in details", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "codex-ring-tool-"));
		directories.push(agentDir);
		const generated: GeneratedImage = {
			base64: PNG_BASE64,
			bytes: Buffer.from(PNG_BASE64, "base64"),
			metadata: { background: "transparent", size: "1024x1024" },
		};
		const router = {
			async runAccountOperation() {
				return generated;
			},
		} as unknown as RingRouter;
		const tool = createImageTool(router, {} as ImagesClient, agentDir);
		const result = await tool.execute("call-1", { prompt: "a fox" }, undefined, undefined, context("/project"));
		const expectedPath = join(agentDir, "image_gen", "--project--", "session-1", "call-1.png");
		expect(result.content[0]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		expect(result.details).toMatchObject({
			savedPath: expectedPath,
			submittedPrompt: "a fox",
			operation: "generate",
			model: "gpt-image-2.5-flare-2026-09-08",
			referencedImageCount: 0,
			background: "transparent",
		});
		expect(JSON.stringify(result.details)).not.toContain(PNG_BASE64);
		expect(await readFile(expectedPath, "base64")).toBe(PNG_BASE64);
	});

	it("forwards an explicit GPT Image 2 selection", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "codex-ring-tool-"));
		directories.push(agentDir);
		const generated: GeneratedImage = {
			base64: PNG_BASE64,
			bytes: Buffer.from(PNG_BASE64, "base64"),
			metadata: {},
		};
		const request = vi.fn<ImagesClient["request"]>(async () => generated);
		const router = {
			async runAccountOperation(operation: AccountOperation<GeneratedImage>) {
				return operation.execute(
					{} as never,
					"https://chatgpt.com/backend-api",
					new AbortController().signal,
				);
			},
		} as unknown as RingRouter;
		const tool = createImageTool(router, { request } as unknown as ImagesClient, agentDir);
		const result = await tool.execute("call-2", {
			prompt: "a fox",
			model: "gpt-image-2-2026-04-21",
		}, undefined, undefined, context("/project"));

		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[2]).toEqual({
			prompt: "a fox",
			model: "gpt-image-2-2026-04-21",
		});
		expect(result.details.model).toBe("gpt-image-2-2026-04-21");
	});

	it("rejects conflicting edit selectors before routing", async () => {
		let called = false;
		const router = {
			async runAccountOperation() {
				called = true;
			},
		} as unknown as RingRouter;
		const tool = createImageTool(router, {} as ImagesClient, "/agent");
		await expect(tool.execute("call", {
			prompt: "edit",
			referenced_image_paths: ["/image.png"],
			num_last_images_to_include: 1,
		}, undefined, undefined, context("/project"))).rejects.toThrow("provide only one");
		expect(called).toBe(false);
	});

	it("classifies only authoritative quota and authentication failures as switchable", () => {
		expect(classifyImageFailure(new ImageRequestError("quota", "http", {
			status: 429,
			observedAt: 1,
			code: "usage_limit_reached",
			activeLimit: "image_gen",
		}))).toMatchObject({ kind: "usage_limit", limitId: "image_gen" });
		expect(classifyImageFailure(new ImageRequestError("temporary", "http", {
			status: 429,
			observedAt: 1,
			code: "rate_limit_exceeded",
		}))).toEqual({ kind: "other" });
		expect(classifyImageFailure(new ImageRequestError("policy", "http", {
			status: 403,
			observedAt: 1,
			code: "content_policy_violation",
		}))).toEqual({ kind: "other" });
		expect(classifyImageFailure(new ImageRequestError("auth", "http", {
			status: 401,
			observedAt: 1,
		}))).toMatchObject({ kind: "auth" });
	});
});
