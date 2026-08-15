import { createHash } from "node:crypto";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { JwtIdentity } from "./types.ts";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_CLAIM_LENGTH = 512;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_CLAIM_LENGTH &&
		/^[\x20-\x7e]+$/.test(value)
		? value
		: undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) throw new Error("OAuth access token is not a JWT");
	try {
		const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("JWT payload is not an object");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Could not decode OAuth access token: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function fingerprintSecret(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function identifyAccount(accessToken: string): JwtIdentity {
	const payload = decodeJwtPayload(accessToken);
	const rawAuth = payload[OPENAI_AUTH_CLAIM];
	const auth =
		typeof rawAuth === "object" && rawAuth !== null && !Array.isArray(rawAuth)
			? (rawAuth as Record<string, unknown>)
			: {};
	const accountId = nonEmptyString(auth.chatgpt_account_id);
	if (!accountId) throw new Error("OAuth access token has no ChatGPT account ID");
	const userId = nonEmptyString(auth.chatgpt_user_id) ?? nonEmptyString(payload.sub);
	const planType = nonEmptyString(auth.chatgpt_plan_type) ?? nonEmptyString(auth.chatgpt_plan_name);
	const fingerprintInput = `${userId ?? "unknown-user"}\0${accountId}`;
	const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 24);
	return {
		accountId,
		fingerprint,
		...(userId ? { userId } : {}),
		...(planType ? { planType } : {}),
	};
}

/** Merge headers case-insensitively; later maps win and null removes a key. */
export function mergeHeaders(...maps: Array<ProviderHeaders | undefined>): ProviderHeaders | undefined {
	const result: ProviderHeaders = {};
	let sawValue = false;
	for (const map of maps) {
		if (!map) continue;
		for (const [name, value] of Object.entries(map)) {
			for (const existing of Object.keys(result)) {
				if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
			}
			result[name] = value;
			sawValue = true;
		}
	}
	return sawValue ? result : undefined;
}

export function sanitizeErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
		.replace(/(?:access|refresh)[_-]?token["'\s:=]+[^\s,"'}]+/gi, "token=[redacted]")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.slice(0, 500);
}
