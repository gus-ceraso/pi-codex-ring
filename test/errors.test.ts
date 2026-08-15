import { describe, expect, it } from "vitest";
import { classifyFailure, normalizeTransientRateLimitMessage } from "../src/errors.js";
import { assistant, testModel } from "./helpers.js";

describe("failure classification", () => {
	it("distinguishes subscription exhaustion from transient 429 throttling", () => {
		const message = assistant(testModel, { stopReason: "error", errorMessage: "friendly usage limit text" });
		expect(
			classifyFailure(message, {
				httpError: { status: 429, observedAt: 1, code: "usage_limit_reached", resetAt: 1000 },
			}),
		).toMatchObject({ kind: "usage_limit", resetAt: 1000 });
		const transient = classifyFailure(message, {
			httpError: { status: 429, observedAt: 1, code: "rate_limit_exceeded", message: "requests per minute" },
		});
		expect(transient).toMatchObject({ kind: "transient_rate_limit" });
		expect(normalizeTransientRateLimitMessage(message, transient).errorMessage).toContain("rate_limit_exceeded");
		const confirmedExhaustion = classifyFailure(
			message,
			{ httpError: { status: 429, observedAt: 1, code: "rate_limit_exceeded" } },
			{
				observedAt: 2,
				source: "usage_endpoint",
				limits: [{ limitId: "codex", allowed: false, limitReached: true }],
			},
		);
		expect(confirmedExhaustion.kind).toBe("usage_limit");
		expect(
			classifyFailure(message, {
				httpError: {
					status: 403,
					observedAt: 1,
					type: "usage_limit_reached",
				},
			}).kind,
		).toBe("usage_limit");
		expect(
			classifyFailure(message, {
				httpError: {
					status: 429,
					observedAt: 1,
					code: "rate_limit_exceeded",
					rateLimitReachedType: "rate_limit_reached",
				},
			}).kind,
		).toBe("usage_limit");
	});

	it("recognizes auth and model entitlement failures", () => {
		const message = assistant(testModel, { stopReason: "error", errorMessage: "failed" });
		expect(classifyFailure(message, { httpError: { status: 401, observedAt: 1 } })).toEqual({ kind: "auth" });
		expect(
			classifyFailure(message, { httpError: { status: 403, observedAt: 1, code: "usage_not_included" } }),
		).toEqual({ kind: "usage_not_included" });
	});

	it("does not rotate on arbitrary network errors", () => {
		const message = assistant(testModel, { stopReason: "error", errorMessage: "socket disconnected" });
		expect(classifyFailure(message, {})).toEqual({ kind: "other" });
	});
});
