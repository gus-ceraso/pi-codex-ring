import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage, type SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_EDIT_IMAGES = 5;
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_AGGREGATE_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 100_000;
const DIRECT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
	return bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
	if (bytes.length < offset + expected.length) return false;
	for (let index = 0; index < expected.length; index++) {
		if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
	}
	return true;
}

export function detectImageMimeType(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) return "image/gif";
	if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) return "image/webp";
	if (startsWithAscii(bytes, 0, "BM")) return "image/bmp";
	return undefined;
}

function decodeBase64(data: string): Uint8Array {
	if (
		data.length === 0 ||
		data.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	) throw new Error("conversation image contains invalid base64 data");
	return Buffer.from(data, "base64");
}

async function processImageBytes(bytes: Uint8Array, source: string): Promise<string> {
	if (bytes.length === 0) throw new Error(`unable to process referenced image at \`${source}\`: file is empty`);
	if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
		throw new Error(`unable to process referenced image at \`${source}\`: file exceeds 50 MiB`);
	}
	const mimeType = detectImageMimeType(bytes);
	if (!mimeType) {
		throw new Error(`unable to process referenced image at \`${source}\`: unsupported image format`);
	}
	const validated = await resizeImage(bytes, mimeType, {
		maxWidth: MAX_IMAGE_DIMENSION,
		maxHeight: MAX_IMAGE_DIMENSION,
		maxBytes: Number.MAX_SAFE_INTEGER,
	});
	if (!validated || validated.wasResized) {
		throw new Error(`unable to process referenced image at \`${source}\`: invalid or oversized image`);
	}
	if (DIRECT_IMAGE_MIME_TYPES.has(mimeType)) {
		return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
	}

	// Pi's worker-backed image processor converts formats such as BMP to a
	// provider-compatible PNG or JPEG. Its normal bounds also avoid sending an
	// unexpectedly huge expanded bitmap.
	const converted = await resizeImage(bytes, mimeType, {
		maxWidth: validated.width,
		maxHeight: validated.height,
		// Matching the source's encoded size forces Pi to re-encode rather than
		// return unsupported source bytes unchanged.
		maxBytes: Math.ceil(bytes.length / 3) * 4,
	});
	if (!converted || !DIRECT_IMAGE_MIME_TYPES.has(converted.mimeType)) {
		throw new Error(`unable to process referenced image at \`${source}\`: conversion failed`);
	}
	return `data:${converted.mimeType};base64,${converted.data}`;
}

function assertAggregateSize(sizes: number[]): void {
	const total = sizes.reduce((sum, value) => sum + value, 0);
	if (total > MAX_AGGREGATE_INPUT_BYTES) {
		throw new Error("referenced images exceed the 100 MiB aggregate input limit");
	}
}

export async function localImageDataUrls(paths: string[]): Promise<string[]> {
	if (paths.length > MAX_EDIT_IMAGES) throw new Error("`referenced_image_paths` must contain at most 5 paths");
	const sizes: number[] = [];
	for (const path of paths) {
		if (!isAbsolute(path)) throw new Error(`referenced image path must be absolute: \`${path}\``);
		let info;
		try {
			info = await stat(path);
		} catch (error) {
			throw new Error(`unable to read referenced image at \`${path}\`: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!info.isFile()) throw new Error(`referenced image is not a regular file: \`${path}\``);
		if (info.size > MAX_INPUT_IMAGE_BYTES) {
			throw new Error(`unable to process referenced image at \`${path}\`: file exceeds 50 MiB`);
		}
		sizes.push(info.size);
	}
	assertAggregateSize(sizes);

	const results: string[] = [];
	for (const path of paths) {
		let bytes: Uint8Array;
		try {
			bytes = await readFile(path);
		} catch (error) {
			throw new Error(`unable to read referenced image at \`${path}\`: ${error instanceof Error ? error.message : String(error)}`);
		}
		results.push(await processImageBytes(bytes, path));
	}
	return results;
}

function contentImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((item): item is ImageContent => {
		if (typeof item !== "object" || item === null) return false;
		const candidate = item as Partial<ImageContent>;
		return candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string";
	});
}

export function recentImageContents(entries: SessionEntry[], count: number): ImageContent[] {
	if (!Number.isInteger(count) || count < 1 || count > MAX_EDIT_IMAGES) {
		throw new Error("`num_last_images_to_include` must be between 1 and 5");
	}
	const images: ImageContent[] = [];
	for (let entryIndex = entries.length - 1; entryIndex >= 0 && images.length < count; entryIndex--) {
		const entry = entries[entryIndex];
		if (!entry) continue;
		let content: unknown;
		if (entry.type === "custom_message") content = entry.content;
		else if (entry.type === "message") {
			const message = entry.message as { role?: unknown; content?: unknown };
			if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
				content = message.content;
			}
		}
		const candidates = contentImages(content);
		for (let imageIndex = candidates.length - 1; imageIndex >= 0 && images.length < count; imageIndex--) {
			const image = candidates[imageIndex];
			if (image) images.push(image);
		}
	}
	images.reverse();
	return images;
}

export async function recentImageDataUrls(entries: SessionEntry[], count: number): Promise<string[]> {
	const contents = recentImageContents(entries, count);
	if (contents.length !== count) {
		throw new Error(`requested the last ${count} conversation images, but only ${contents.length} were available`);
	}
	const decoded = contents.map((image) => decodeBase64(image.data));
	assertAggregateSize(decoded.map((bytes) => bytes.length));
	const results: string[] = [];
	for (const [index, bytes] of decoded.entries()) {
		results.push(await processImageBytes(bytes, `conversation image ${index + 1}`));
	}
	return results;
}
