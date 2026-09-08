import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	imageArtifactPath,
	normalizeProjectRoot,
	saveImageArtifact,
} from "../src/image-artifact.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("image artifacts", () => {
	it("uses Pi's normalized project path and sanitized IDs", () => {
		expect(normalizeProjectRoot("/home/user/my-app")).toBe("--home-user-my-app--");
		expect(imageArtifactPath("/agent", "/home/user/my-app", "session/id", "call:id"))
			.toBe("/agent/image_gen/--home-user-my-app--/session_id/call_id.png");
	});

	it("writes privately and never overwrites an existing image", async () => {
		const root = await mkdtemp(join(tmpdir(), "codex-ring-images-"));
		directories.push(root);
		const path = imageArtifactPath(root, "/project", "session", "call");
		await saveImageArtifact(path, Uint8Array.from([1, 2, 3]));
		expect([...await readFile(path)]).toEqual([1, 2, 3]);
		await expect(saveImageArtifact(path, Uint8Array.from([4]))).rejects.toMatchObject({ code: "EEXIST" });
		expect([...await readFile(path)]).toEqual([1, 2, 3]);
	});
});
