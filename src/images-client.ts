import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { mergeHeaders, sanitizeErrorMessage } from "./account.ts";
import { parseCapturedHttpError, parseRateLimitHeaders } from "./quota.ts";
import { PACKAGE_VERSION, type CapturedHttpError, type QuotaObservation, type ResolvedAccount } from "./types.ts";

export const IMAGE_MODELS = [
	"gpt-image-2.5-flare-2026-09-08",
	"gpt-image-2.5-sunburst-2026-09-08",
	"gpt-image-2-2026-04-21",
] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
export const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2.5-flare-2026-09-08";
export const IMAGE_RESOURCE_ID = "image_gen";
export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BASE64_BYTES = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;
const MAX_SUCCESS_BODY_BYTES = 48 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageRequest {
	prompt: string;
	model: ImageModel;
	images?: string[];
}

export interface ImageResponseMetadata {
	background?: "transparent" | "opaque" | "auto";
	quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
	size?: string;
	requestId?: string;
}

export interface GeneratedImage {
	base64: string;
	bytes: Uint8Array;
	metadata: ImageResponseMetadata;
	observation?: QuotaObservation;
}

export type ImageFetch = (
	url: string,
	init: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export class ImageRequestError extends Error {
	constructor(
		message: string,
		readonly kind: "aborted" | "timeout" | "network" | "http" | "invalid_response",
		readonly captured?: CapturedHttpError,
	) {
		super(message);
		this.name = "ImageRequestError";
	}
}

function proxyValue(env: Record<string, string> | undefined, upper: string, lower: string): string | undefined {
	return env?.[upper] ?? env?.[lower] ?? process.env[upper] ?? process.env[lower];
}

async function readTextLimited(response: Response, maximum: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximum) throw new Error(`response exceeds ${maximum} bytes`);
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Ignore cleanup failures after reading or rejecting a body.
		}
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ImageRequestError(
			`Image endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			"invalid_response",
		);
	}
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function responseString(value: unknown, maximum: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
	if (/[^\x20-\x7e]/.test(value)) return undefined;
	return value;
}

function metadataValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function decodeGeneratedPng(base64: string): Uint8Array {
	const encoded = base64.trim();
	if (encoded.length === 0 || encoded.length > MAX_GENERATED_IMAGE_BASE64_BYTES) {
		throw new ImageRequestError("Image endpoint returned empty or oversized image data", "invalid_response");
	}
	if (
		encoded.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
	) {
		throw new ImageRequestError("Image endpoint returned invalid base64 image data", "invalid_response");
	}
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
		throw new ImageRequestError("Generated image exceeds the 32 MiB output limit", "invalid_response");
	}
	if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		throw new ImageRequestError("Image endpoint returned a non-PNG result", "invalid_response");
	}
	return bytes;
}

export function resolveImagesUrl(baseUrl: string, edit: boolean): string {
	const url = new URL(baseUrl);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Codex image endpoint must use HTTP or HTTPS");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	if (
		(url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
		!url.pathname.includes("/backend-api")
	) {
		url.pathname = `${url.pathname}/backend-api`.replace(/\/+/g, "/");
	}
	if (url.pathname.endsWith("/backend-api")) url.pathname += "/codex";
	url.pathname += edit ? "/images/edits" : "/images/generations";
	return url.toString();
}

function requestBody(request: ImageRequest): Record<string, unknown> {
	return {
		...(request.images ? { images: request.images.map((imageUrl) => ({ image_url: imageUrl })) } : {}),
		prompt: request.prompt,
		background: "auto",
		model: request.model,
		quality: "auto",
		size: "auto",
	};
}

function parseSuccess(text: string, headers: Headers): GeneratedImage {
	const root = objectValue(parseJson(text));
	if (!root || !Array.isArray(root.data)) {
		throw new ImageRequestError("Image endpoint returned no image data", "invalid_response");
	}
	const first = objectValue(root.data[0]);
	if (!first || typeof first.b64_json !== "string") {
		throw new ImageRequestError("Image endpoint returned no image data", "invalid_response");
	}
	const base64 = first.b64_json.trim();
	const bytes = decodeGeneratedPng(base64);
	const background = metadataValue(root.background, ["transparent", "opaque", "auto"] as const);
	const quality = metadataValue(root.quality, ["low", "medium", "high", "xhigh", "max", "auto"] as const);
	const size = responseString(root.size, 64);
	const requestId = responseString(headers.get("x-codex-imagegen-request-id"), 1024);
	const metadata: ImageResponseMetadata = {
		...(background ? { background } : {}),
		...(quality ? { quality } : {}),
		...(size ? { size } : {}),
		...(requestId ? { requestId } : {}),
	};
	const observation = parseRateLimitHeaders(headers);
	return {
		base64,
		bytes,
		metadata,
		...(observation ? { observation } : {}),
	};
}

export class ImagesClient {
	private readonly agents = new Map<string, EnvHttpProxyAgent>();

	constructor(
		private readonly fetchImpl?: ImageFetch,
		private readonly timeoutMs = IMAGE_REQUEST_TIMEOUT_MS,
	) {}

	async request(
		account: ResolvedAccount,
		baseUrl: string,
		request: ImageRequest,
		signal?: AbortSignal,
	): Promise<GeneratedImage> {
		if (signal?.aborted) throw new ImageRequestError("Image request was aborted", "aborted");
		const edit = request.images !== undefined;
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const headers = new Headers();
		const resolvedHeaders = mergeHeaders(account.auth.auth.headers);
		for (const [name, value] of Object.entries(resolvedHeaders ?? {})) {
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
		headers.set("Accept", "application/json");
		headers.set("Content-Type", "application/json");
		headers.set("Originator", "pi");
		headers.set("User-Agent", `pi-codex-ring/${PACKAGE_VERSION}`);
		headers.set("Authorization", `Bearer ${account.apiKey}`);
		headers.set("ChatGPT-Account-ID", account.identity.accountId);
		const init: RequestInit & { dispatcher?: Dispatcher } = {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody(request)),
			redirect: "error",
			signal: combined,
		};
		if (!this.fetchImpl) init.dispatcher = this.agentFor(account.env);

		let response: Response;
		try {
			response = await (this.fetchImpl ?? (undiciFetch as unknown as ImageFetch))(
				resolveImagesUrl(baseUrl, edit),
				init,
			);
		} catch (error) {
			if (signal?.aborted) throw new ImageRequestError("Image request was aborted", "aborted");
			if (timeout.aborted) {
				throw new ImageRequestError(`Image request timed out after ${this.timeoutMs}ms`, "timeout");
			}
			throw new ImageRequestError(`Image request failed: ${sanitizeErrorMessage(error)}`, "network");
		}

		if (!response.ok) {
			let body: unknown;
			try {
				const text = await readTextLimited(response, MAX_ERROR_BODY_BYTES);
				body = text.trim() ? JSON.parse(text) : undefined;
			} catch {
				// Status and headers still support narrow failure classification.
			}
			const captured = parseCapturedHttpError(response.status, body, response.headers);
			const detail = captured.message ?? captured.code ?? captured.type;
			throw new ImageRequestError(
				`Image ${edit ? "edit" : "generation"} failed with HTTP ${response.status}${detail ? `: ${sanitizeErrorMessage(detail)}` : ""}`,
				"http",
				captured,
			);
		}

		let text: string;
		try {
			text = await readTextLimited(response, MAX_SUCCESS_BODY_BYTES);
		} catch (error) {
			throw new ImageRequestError(
				`Image response could not be read: ${error instanceof Error ? error.message : String(error)}`,
				"invalid_response",
			);
		}
		return parseSuccess(text, response.headers);
	}

	async close(): Promise<void> {
		const agents = [...this.agents.values()];
		this.agents.clear();
		await Promise.allSettled(agents.map((agent) => agent.close()));
	}

	private agentFor(env: Record<string, string> | undefined): EnvHttpProxyAgent {
		const httpProxy = proxyValue(env, "HTTP_PROXY", "http_proxy");
		const httpsProxy = proxyValue(env, "HTTPS_PROXY", "https_proxy");
		const noProxy = proxyValue(env, "NO_PROXY", "no_proxy");
		const key = JSON.stringify([httpProxy ?? "", httpsProxy ?? "", noProxy ?? ""]);
		let agent = this.agents.get(key);
		if (!agent) {
			agent = new EnvHttpProxyAgent({
				...(httpProxy !== undefined ? { httpProxy } : {}),
				...(httpsProxy !== undefined ? { httpsProxy } : {}),
				...(noProxy !== undefined ? { noProxy } : {}),
			});
			this.agents.set(key, agent);
		}
		return agent;
	}
}
