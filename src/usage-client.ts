import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { parseUsagePayload } from "./quota.ts";
import { PACKAGE_VERSION, type PollResult, type ResolvedAccount } from "./types.ts";

const MAX_USAGE_BODY_BYTES = 1024 * 1024;

export type UsageFetch = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

export interface UsagePoller {
	poll(account: ResolvedAccount, baseUrl: string, signal?: AbortSignal): Promise<PollResult>;
	close(): Promise<void>;
}

export function resolveUsageUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	if ((url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && !url.pathname.includes("/backend-api")) {
		url.pathname = `${url.pathname}/backend-api`.replace(/\/+/g, "/");
	}
	if (url.pathname.includes("/backend-api")) {
		url.pathname = `${url.pathname}/wham/usage`.replace(/\/+/g, "/");
	} else {
		url.pathname = `${url.pathname}/api/codex/usage`.replace(/\/+/g, "/");
	}
	return url.toString();
}

function proxyValue(env: Record<string, string> | undefined, upper: string, lower: string): string | undefined {
	return env?.[upper] ?? env?.[lower] ?? process.env[upper] ?? process.env[lower];
}

async function readTextLimited(response: Response, maximum = MAX_USAGE_BODY_BYTES): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let result = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) throw new Error(`response exceeds ${maximum} bytes`);
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();
		return result;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Ignore cancellation failures after reading or rejecting a body.
		}
		try {
			reader.releaseLock();
		} catch {
			// Ignore release failures.
		}
	}
}

export class UsageClient implements UsagePoller {
	private readonly agents = new Map<string, EnvHttpProxyAgent>();

	constructor(
		private readonly timeoutMs: number,
		private readonly fetchImpl?: UsageFetch,
	) {}

	async poll(account: ResolvedAccount, baseUrl: string, signal?: AbortSignal): Promise<PollResult> {
		if (signal?.aborted) return { ok: false, kind: "aborted", message: "Usage poll aborted" };
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			const url = resolveUsageUrl(baseUrl);
			const headers = new Headers({
				Accept: "application/json",
				Authorization: `Bearer ${account.apiKey}`,
				"Cache-Control": "no-store",
				"ChatGPT-Account-Id": account.identity.accountId,
				"User-Agent": `pi-codex-ring/${PACKAGE_VERSION}`,
			});
			const init: RequestInit & { dispatcher?: Dispatcher } = {
				method: "GET",
				headers,
				redirect: "error",
				signal: combined,
			};
			if (!this.fetchImpl) init.dispatcher = this.agentFor(account.env);
			const response = await (this.fetchImpl ?? (undiciFetch as unknown as UsageFetch))(url, init);
			if (response.status === 401 || response.status === 403) {
				await response.body?.cancel().catch(() => undefined);
				return {
					ok: false,
					kind: "unauthorized",
					status: response.status,
					message: `Usage endpoint returned HTTP ${response.status}`,
				};
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				return {
					ok: false,
					kind: "http",
					status: response.status,
					message: `Usage endpoint returned HTTP ${response.status}`,
				};
			}
			let payload: unknown;
			try {
				payload = JSON.parse(await readTextLimited(response));
			} catch (error) {
				return {
					ok: false,
					kind: "invalid_payload",
					message: `Invalid usage response: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			try {
				return { ok: true, observation: parseUsagePayload(payload, Date.now()) };
			} catch (error) {
				return {
					ok: false,
					kind: "invalid_payload",
					message: `Invalid usage response: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		} catch (error) {
			if (signal?.aborted) return { ok: false, kind: "aborted", message: "Usage poll aborted" };
			const message = timeout.aborted
				? `Usage poll timed out after ${this.timeoutMs}ms`
				: `Usage poll failed: ${error instanceof Error ? error.message : String(error)}`;
			return { ok: false, kind: "network", message: message.slice(0, 300) };
		}
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
