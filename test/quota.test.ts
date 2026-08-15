import { describe, expect, it } from "vitest";
import {
	buildHardStop,
	classifyWindowDuration,
	observationHasHardStop,
	parseCapturedHttpError,
	parseRateLimitHeaders,
	parseUsagePayload,
} from "../src/quota.js";

describe("quota parsing", () => {
	it("classifies windows by duration rather than primary/secondary position", () => {
		expect(classifyWindowDuration(300)).toBe("five_hour");
		expect(classifyWindowDuration(299)).toBe("five_hour");
		expect(classifyWindowDuration(10_080)).toBe("weekly");
		expect(classifyWindowDuration(10_079)).toBe("weekly");
		expect(classifyWindowDuration(1_440)).toBe("other");
	});

	it("parses five-hour, weekly, credits, spend controls, and additional limits", () => {
		const now = 1_800_000_000_000;
		const observation = parseUsagePayload(
			{
				plan_type: "plus",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 604_800,
						reset_at: 1_800_604_800,
					},
					secondary_window: {
						used_percent: 75,
						limit_window_seconds: 18_000,
						reset_after_seconds: 3_600,
					},
				},
				credits: { has_credits: true, unlimited: false, balance: "4.25" },
				spend_control: {
					reached: false,
					individual_limit: { remaining_percent: 60, reset_at: 1_900_000_000 },
				},
				additional_rate_limits: [
					{
						limit_name: "Sonic",
						metered_feature: "codex_sonic",
						rate_limit: {
							primary_window: { used_percent: 10, limit_window_seconds: 900, reset_at: 1_800_000_900 },
						},
					},
				],
			},
			now,
		);
		const base = observation.limits[0];
		expect(base?.primary?.kind).toBe("weekly");
		expect(base?.secondary?.kind).toBe("five_hour");
		expect(base?.secondary?.resetAt).toBe(now + 3_600_000);
		expect(base?.credits).toEqual({ hasCredits: true, unlimited: false, balance: "4.25" });
		expect(observation.limits[1]).toMatchObject({ limitId: "codex_sonic", limitName: "Sonic" });
	});

	it("parses all header families", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "31.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1800000300",
			"x-codex-secondary-used-percent": "82",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-sonic-primary-used-percent": "50",
			"x-codex-sonic-primary-window-minutes": "15",
			"x-codex-sonic-limit-name": "Sonic",
		});
		const observation = parseRateLimitHeaders(headers, 100);
		expect(observation?.limits.map((limit) => limit.limitId).sort()).toEqual(["codex", "codex_sonic"]);
		expect(observation?.limits.find((limit) => limit.limitId === "codex")?.secondary?.kind).toBe("weekly");
	});

	it("uses explicit hard-stop fields, not percentages alone", () => {
		const atHundredButAllowed = parseUsagePayload({
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
			},
		});
		expect(observationHasHardStop(atHundredButAllowed)).toBe(false);
		const blocked = parseUsagePayload({
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
				secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 2_100_000_000 },
			},
		});
		expect(observationHasHardStop(blocked)).toBe(true);
		const stop = buildHardStop(blocked, { kind: "usage_limit" });
		expect(stop.resetAt).toBe(2_100_000_000_000);
		expect(stop.exhaustedWindows.map((window) => window.kind).sort()).toEqual(["five_hour", "weekly"]);
	});

	it("classifies workspace caps and scopes a single additional hard stop", () => {
		const workspace = parseUsagePayload({
			rate_limit: { allowed: false, limit_reached: true },
			rate_limit_reached_type: { type: "workspace_owner_usage_limit_reached" },
		});
		expect(buildHardStop(workspace, { kind: "endpoint_hard_stop" }).kind).toBe("spend_cap");

		const additional = parseUsagePayload({
			rate_limit: { allowed: true, limit_reached: false },
			additional_rate_limits: [
				{
					metered_feature: "codex-sonic",
					rate_limit: { allowed: false, limit_reached: true },
				},
			],
		});
		expect(buildHardStop(additional, { kind: "endpoint_hard_stop" }).limitId).toBe("codex_sonic");
	});

	it("captures structured HTTP error details without retaining the body", () => {
		const error = parseCapturedHttpError(
			429,
			{ error: { type: "usage_limit_reached", message: "limit", resets_at: 2_000_000_000 } },
			new Headers({ "x-codex-active-limit": "codex-sonic" }),
			123,
		);
		expect(error).toMatchObject({
			status: 429,
			type: "usage_limit_reached",
			resetAt: 2_000_000_000_000,
			activeLimit: "codex_sonic",
		});
		expect(error).not.toHaveProperty("body");
	});
});
