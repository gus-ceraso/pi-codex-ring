import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sanitizeErrorMessage } from "./account.ts";
import { observationHasHardStop } from "./quota.ts";
import type { AttemptCapture, FailureClassification, QuotaObservation } from "./types.ts";

const USAGE_CODES = new Set([
	"usage_limit_reached",
	"insufficient_quota",
	"quota_exceeded",
	"go_usage_limit_error",
	"free_usage_limit_error",
]);

function normalized(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

export function classifyFailure(
	message: AssistantMessage,
	capture: AttemptCapture,
	pollObservation?: QuotaObservation,
): FailureClassification {
	if (message.stopReason === "aborted") return { kind: "aborted" };
	const error = capture.httpError;
	const code = normalized(error?.code || error?.type);
	const type = normalized(error?.type);
	const reachedType = normalized(error?.rateLimitReachedType ?? pollObservation?.rateLimitReachedType);

	if (code === "usage_not_included" || type === "usage_not_included") return { kind: "usage_not_included" };
	if (
		USAGE_CODES.has(code) ||
		USAGE_CODES.has(type) ||
		reachedType.includes("credits_depleted") ||
		reachedType.includes("usage_limit") ||
		reachedType.includes("rate_limit")
	) {
		return {
			kind: "usage_limit",
			...(error?.resetAt !== undefined ? { resetAt: error.resetAt } : {}),
			...(error?.activeLimit ? { limitId: error.activeLimit } : {}),
			...(error?.rateLimitReachedType ? { reachedType: error.rateLimitReachedType } : {}),
		};
	}
	if (error?.status === 401 || error?.status === 403) return { kind: "auth" };
	if (pollObservation && observationHasHardStop(pollObservation)) {
		return {
			kind: "usage_limit",
			...(error?.resetAt !== undefined ? { resetAt: error.resetAt } : {}),
			...(error?.activeLimit ? { limitId: error.activeLimit } : {}),
			...(pollObservation.rateLimitReachedType
				? { reachedType: pollObservation.rateLimitReachedType }
				: {}),
		};
	}
	if (code === "rate_limit_exceeded" || type === "rate_limit_exceeded" || error?.status === 429) {
		return {
			kind: "transient_rate_limit",
			...(error?.message ? { message: error.message } : {}),
		};
	}

	// WebSocket errors do not expose their structured payload through Pi's public
	// stream. Use only narrow phrases here; generic "rate limit" is transient.
	if (!error) {
		const text = message.errorMessage ?? "";
		if (/usage_not_included/i.test(text)) return { kind: "usage_not_included" };
		if (
			/usage_limit_reached|you (?:have|['’]ve) hit your (?:chatgpt )?usage limit|workspace is out of credits|you hit your spend cap/i.test(
				text,
			)
		) {
			return { kind: "usage_limit" };
		}
		if (/\b401\b|\b403\b|unauthorized|invalid (?:oauth|token)|token refresh/i.test(text)) {
			return { kind: "auth" };
		}
	}
	return { kind: "other" };
}

export function normalizeTransientRateLimitMessage(
	message: AssistantMessage,
	classification: FailureClassification,
): AssistantMessage {
	if (classification.kind !== "transient_rate_limit") return message;
	const detail = classification.message ? sanitizeErrorMessage(classification.message).trim() : undefined;
	return {
		...message,
		errorMessage: `rate_limit_exceeded: ${detail || "The provider temporarily rate limited this request"}`,
	};
}
