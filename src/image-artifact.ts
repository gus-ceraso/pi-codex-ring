import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SAFE_ID_PATTERN = /[^A-Za-z0-9_-]/g;

function sanitizeId(value: string, fallback: string): string {
	const sanitized = value.replace(SAFE_ID_PATTERN, "_").slice(0, 200);
	return sanitized || fallback;
}

export function normalizeProjectRoot(cwd: string): string {
	const normalized = resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");
	return `--${normalized || "root"}--`;
}

export function imageArtifactPath(
	agentDir: string,
	cwd: string,
	sessionId: string,
	toolCallId: string,
): string {
	return join(
		agentDir,
		"image_gen",
		normalizeProjectRoot(cwd),
		sanitizeId(sessionId, "session"),
		`${sanitizeId(toolCallId, "generated_image")}.png`,
	);
}

export async function saveImageArtifact(path: string, bytes: Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(path).catch(() => undefined);
		throw error;
	}
	await handle.close();
}
