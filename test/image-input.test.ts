import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectImageMimeType,
	localImageDataUrls,
	recentImageContents,
	recentImageDataUrls,
} from "../src/image-input.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function base(id: string, parentId: string | null) {
	return { id, parentId, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("image inputs", () => {
	it("detects supported formats from bytes instead of extensions", () => {
		expect(detectImageMimeType(Buffer.from(PNG_BASE64, "base64"))).toBe("image/png");
		expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(detectImageMimeType(Buffer.from("not an image"))).toBeUndefined();
	});

	it("loads and validates an absolute local image path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codex-ring-input-"));
		directories.push(directory);
		const path = join(directory, "misleading.txt");
		await writeFile(path, Buffer.from(PNG_BASE64, "base64"));
		await expect(localImageDataUrls([path])).resolves.toEqual([`data:image/png;base64,${PNG_BASE64}`]);
		await expect(localImageDataUrls(["relative.png"])).rejects.toThrow("must be absolute");
	});

	it("selects recent user, tool-result, and custom-message images in chronological order", async () => {
		const entries: SessionEntry[] = [
			{
				...base("1", null),
				type: "message",
				message: {
					role: "user",
					content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
					timestamp: 1,
				},
			},
			{
				...base("2", "1"),
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call",
					toolName: "image_gen",
					content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
					isError: false,
					timestamp: 2,
				},
			},
			{
				...base("3", "2"),
				type: "custom_message",
				customType: "example",
				content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
				display: false,
			},
		];
		const selected = recentImageContents(entries, 2);
		expect(selected).toHaveLength(2);
		expect(selected[0]).toBe(entries[1]?.type === "message" ? (entries[1].message as any).content[0] : undefined);
		expect(selected[1]).toBe(entries[2]?.type === "custom_message" ? entries[2].content[0] : undefined);
		await expect(recentImageDataUrls(entries, 4)).rejects.toThrow("only 3 were available");
	});
});
