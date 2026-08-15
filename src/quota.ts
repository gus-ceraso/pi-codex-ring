import { sanitizeErrorMessage } from "./account.ts";
import type {
	CapturedHttpError,
	CreditsSnapshot,
	ExhaustedWindow,
	HardStop,
	HardStopKind,
	LimitSnapshot,
	QuotaObservation,
	QuotaSource,
	SpendControlSnapshot,
	UsageWindowSnapshot,
	WindowKind,
} from "./types.ts";

const FIVE_HOUR_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
const DURATION_TOLERANCE = 0.05;
const EXHAUSTED_PERCENT = 99.5;

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || (typeof value === "string" && value.toLowerCase() === "true")) {
		return true;
	}
	if (value === 0 || value === "0" || (typeof value === "string" && value.toLowerCase() === "false")) {
		return false;
	}
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = sanitizeErrorMessage(value.trim()).slice(0, 256);
	return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeResetAt(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	if (parsed === undefined || parsed <= 0) return undefined;
	const milliseconds = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
	return Number.isSafeInteger(Math.round(milliseconds)) ? Math.round(milliseconds) : undefined;
}

function resetAtFrom(raw: Record<string, unknown>, observedAt: number): number | undefined {
	const absolute = normalizeResetAt(raw.reset_at ?? raw.resets_at);
	if (absolute !== undefined) return absolute;
	const afterSeconds = finiteNumber(raw.reset_after_seconds);
	if (afterSeconds === undefined || afterSeconds < 0) return undefined;
	return observedAt + Math.round(afterSeconds * 1000);
}

function normalizeLimitId(value: string | undefined): string {
	let normalized = (value ?? "codex")
		.trim()
		.toLowerCase()
		.replaceAll("-", "_")
		.replace(/[^a-z0-9_]/g, "_")
		.slice(0, 128);
	if (!normalized) normalized = "codex";
	if (normalized === "__proto__" || normalized === "prototype" || normalized === "constructor") {
		normalized = `codex_${normalized}`;
	}
	return normalized;
}

export function classifyWindowDuration(windowMinutes: number | undefined): WindowKind {
	if (windowMinutes === undefined || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return "other";
	if (Math.abs(windowMinutes - FIVE_HOUR_MINUTES) <= FIVE_HOUR_MINUTES * DURATION_TOLERANCE) {
		return "five_hour";
	}
	if (Math.abs(windowMinutes - WEEK_MINUTES) <= WEEK_MINUTES * DURATION_TOLERANCE) {
		return "weekly";
	}
	return "other";
}

function parseUsageWindow(
	value: unknown,
	position: "primary" | "secondary",
	observedAt: number,
	source: QuotaSource,
): UsageWindowSnapshot | undefined {
	const raw = objectValue(value);
	if (!raw) return undefined;
	const usedRaw = finiteNumber(raw.used_percent);
	if (usedRaw === undefined || usedRaw < 0) return undefined;
	const seconds = finiteNumber(raw.limit_window_seconds);
	const directMinutes = finiteNumber(raw.window_minutes);
	const windowMinutes =
		seconds !== undefined && seconds > 0
			? Math.ceil(seconds / 60)
			: directMinutes !== undefined && directMinutes > 0
				? Math.round(directMinutes)
				: undefined;
	const resetAt = resetAtFrom(raw, observedAt);
	return {
		position,
		kind: classifyWindowDuration(windowMinutes),
		usedPercent: Math.min(100, usedRaw),
		observedAt,
		source,
		...(windowMinutes !== undefined ? { windowMinutes } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function parseCredits(value: unknown): CreditsSnapshot | undefined {
	const raw = objectValue(value);
	if (!raw) return undefined;
	const hasCredits = booleanValue(raw.has_credits);
	const unlimited = booleanValue(raw.unlimited);
	const balance = stringValue(raw.balance);
	if (hasCredits === undefined && unlimited === undefined && balance === undefined) return undefined;
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(balance !== undefined ? { balance } : {}),
	};
}

function parseSpendControl(value: unknown, observedAt: number): SpendControlSnapshot | undefined {
	const raw = objectValue(value);
	if (!raw) return undefined;
	const reached = booleanValue(raw.reached);
	const individual = objectValue(raw.individual_limit);
	const remainingPercent = finiteNumber(individual?.remaining_percent);
	const resetAt = individual ? resetAtFrom(individual, observedAt) : undefined;
	if (reached === undefined && remainingPercent === undefined && resetAt === undefined) return undefined;
	return {
		...(reached !== undefined ? { reached } : {}),
		...(remainingPercent !== undefined ? { remainingPercent: Math.min(100, Math.max(0, remainingPercent)) } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function reachedType(value: unknown): string | undefined {
	const direct = stringValue(value);
	if (direct) return direct.toLowerCase() === "unknown" ? undefined : direct;
	const raw = objectValue(value);
	const nested = stringValue(raw?.kind ?? raw?.type);
	return nested?.toLowerCase() === "unknown" ? undefined : nested;
}

function parseRateLimit(
	value: unknown,
	limitId: string,
	limitName: string | undefined,
	observedAt: number,
	source: QuotaSource,
): LimitSnapshot {
	const raw = objectValue(value) ?? {};
	const primary = parseUsageWindow(raw.primary_window ?? raw.primary, "primary", observedAt, source);
	const secondary = parseUsageWindow(raw.secondary_window ?? raw.secondary, "secondary", observedAt, source);
	const allowed = booleanValue(raw.allowed);
	const limitReached = booleanValue(raw.limit_reached);
	return {
		limitId: normalizeLimitId(limitId),
		...(limitName ? { limitName } : {}),
		...(allowed !== undefined ? { allowed } : {}),
		...(limitReached !== undefined ? { limitReached } : {}),
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

export function parseUsagePayload(payload: unknown, observedAt = Date.now()): QuotaObservation {
	const root = objectValue(payload);
	if (!root) throw new Error("usage response must be a JSON object");
	const limits: LimitSnapshot[] = [];
	const base = parseRateLimit(root.rate_limit, "codex", undefined, observedAt, "usage_endpoint");
	const credits = parseCredits(root.credits);
	const spendControl = parseSpendControl(root.spend_control, observedAt);
	limits.push({
		...base,
		...(credits ? { credits } : {}),
		...(spendControl ? { spendControl } : {}),
	});
	if (Array.isArray(root.additional_rate_limits)) {
		for (const value of root.additional_rate_limits) {
			const item = objectValue(value);
			if (!item) continue;
			const limitId = stringValue(item.metered_feature) ?? stringValue(item.limit_id) ?? stringValue(item.limit_name);
			if (!limitId) continue;
			limits.push(
				parseRateLimit(
					item.rate_limit,
					limitId,
					stringValue(item.limit_name),
					observedAt,
					"usage_endpoint",
				),
			);
		}
	}
	const planType = stringValue(root.plan_type);
	const rateLimitReachedType = reachedType(root.rate_limit_reached_type);
	return {
		observedAt,
		source: "usage_endpoint",
		limits,
		...(planType ? { planType } : {}),
		...(rateLimitReachedType ? { rateLimitReachedType } : {}),
	};
}

function headersRecord(headers: Headers | Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	if (headers instanceof Headers) {
		for (const [key, value] of headers.entries()) result[key.toLowerCase()] = value;
	} else {
		for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = value;
	}
	return result;
}

function parseHeaderWindow(
	headers: Record<string, string>,
	prefix: string,
	position: "primary" | "secondary",
	observedAt: number,
): UsageWindowSnapshot | undefined {
	const used = finiteNumber(headers[`${prefix}-${position}-used-percent`]);
	if (used === undefined || used < 0) return undefined;
	const minutesRaw = finiteNumber(headers[`${prefix}-${position}-window-minutes`]);
	const windowMinutes = minutesRaw !== undefined && minutesRaw > 0 ? Math.round(minutesRaw) : undefined;
	const resetAt = normalizeResetAt(headers[`${prefix}-${position}-reset-at`]);
	return {
		position,
		kind: classifyWindowDuration(windowMinutes),
		usedPercent: Math.min(100, used),
		observedAt,
		source: "response_headers",
		...(windowMinutes !== undefined ? { windowMinutes } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

export function parseRateLimitHeaders(
	input: Headers | Record<string, string>,
	observedAt = Date.now(),
): QuotaObservation | undefined {
	const headers = headersRecord(input);
	const limitIds = new Set<string>();
	for (const name of Object.keys(headers)) {
		const match = /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(name);
		if (match?.[1]) limitIds.add(normalizeLimitId(match[1]));
	}
	if (
		Object.keys(headers).some((name) => name.startsWith("x-codex-secondary-") || name.startsWith("x-codex-credits-"))
	) {
		limitIds.add("codex");
	}
	if (limitIds.size === 0 && !headers["x-codex-rate-limit-reached-type"]) return undefined;
	if (limitIds.size === 0) limitIds.add("codex");

	const limits: LimitSnapshot[] = [];
	for (const limitId of limitIds) {
		const prefix = `x-${limitId.replaceAll("_", "-")}`;
		const primary = parseHeaderWindow(headers, prefix, "primary", observedAt);
		const secondary = parseHeaderWindow(headers, prefix, "secondary", observedAt);
		const limitName = stringValue(headers[`${prefix}-limit-name`]);
		let credits: CreditsSnapshot | undefined;
		if (limitId === "codex") {
			const hasCredits = booleanValue(headers["x-codex-credits-has-credits"]);
			const unlimited = booleanValue(headers["x-codex-credits-unlimited"]);
			const balance = stringValue(headers["x-codex-credits-balance"]);
			if (hasCredits !== undefined || unlimited !== undefined || balance !== undefined) {
				credits = {
					...(hasCredits !== undefined ? { hasCredits } : {}),
					...(unlimited !== undefined ? { unlimited } : {}),
					...(balance ? { balance } : {}),
				};
			}
		}
		limits.push({
			limitId,
			...(limitName ? { limitName } : {}),
			...(primary ? { primary } : {}),
			...(secondary ? { secondary } : {}),
			...(credits ? { credits } : {}),
		});
	}
	const rateLimitReachedType = reachedType(headers["x-codex-rate-limit-reached-type"]);
	return {
		observedAt,
		source: "response_headers",
		limits,
		...(rateLimitReachedType ? { rateLimitReachedType } : {}),
	};
}

export function parseCapturedHttpError(
	status: number,
	body: unknown,
	headersInput: Headers | Record<string, string>,
	observedAt = Date.now(),
): CapturedHttpError {
	const headers = headersRecord(headersInput);
	const root = objectValue(body);
	const error = objectValue(root?.error) ?? root ?? {};
	const details = objectValue(error.details);
	const code = stringValue(error.code);
	const type = stringValue(error.type);
	const message = stringValue(error.message);
	const planType = stringValue(error.plan_type ?? details?.plan_type);
	const bodyResetAt = normalizeResetAt(
		error.resets_at ?? error.reset_at ?? details?.resets_at ?? details?.reset_at,
	);
	const headerResetCandidates = (parseRateLimitHeaders(headers, observedAt)?.limits ?? [])
		.flatMap((limit) => [limit.primary, limit.secondary])
		.filter(
			(window): window is UsageWindowSnapshot & { resetAt: number } =>
				window !== undefined && window.usedPercent >= EXHAUSTED_PERCENT && window.resetAt !== undefined,
		)
		.map((window) => window.resetAt);
	const resetCandidates = [bodyResetAt, ...headerResetCandidates].filter(
		(value): value is number => value !== undefined,
	);
	const resetAt = resetCandidates.length > 0 ? Math.max(...resetCandidates) : undefined;
	const activeLimit = stringValue(
		headers["x-codex-active-limit"] ?? error.active_limit ?? details?.active_limit,
	);
	const rateLimitReachedType = reachedType(
		error.rate_limit_reached_type ??
			details?.rate_limit_reached_type ??
			root?.rate_limit_reached_type ??
			headers["x-codex-rate-limit-reached-type"],
	);
	return {
		status,
		observedAt,
		...(code ? { code } : {}),
		...(type ? { type } : {}),
		...(message ? { message } : {}),
		...(planType ? { planType } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(activeLimit ? { activeLimit: normalizeLimitId(activeLimit) } : {}),
		...(rateLimitReachedType ? { rateLimitReachedType } : {}),
	};
}

export function observationHasHardStop(observation: QuotaObservation): boolean {
	if (observation.rateLimitReachedType) return true;
	return observation.limits.some(
		(limit) =>
			limit.allowed === false ||
			limit.limitReached === true ||
			limit.spendControl?.reached === true,
	);
}

function inferHardStopKind(observation: QuotaObservation, fallback: HardStopKind): HardStopKind {
	const reached = observation.rateLimitReachedType?.toLowerCase() ?? "";
	if (reached.includes("credits_depleted")) return "credits_depleted";
	if ((reached.includes("workspace_") && reached.includes("usage_limit")) || reached.includes("spend")) {
		return "spend_cap";
	}
	if (reached.includes("usage_limit") || reached.includes("rate_limit")) return "usage_limit";
	if (observation.limits.some((limit) => limit.spendControl?.reached === true)) return "spend_cap";
	return fallback;
}

export function buildHardStop(
	observation: QuotaObservation | undefined,
	options: {
		kind: HardStopKind;
		observedAt?: number;
		resetAt?: number;
		limitId?: string;
		modelId?: string;
		reason?: string;
	},
): HardStop {
	const observedAt = options.observedAt ?? observation?.observedAt ?? Date.now();
	const requestedLimit = options.limitId ? normalizeLimitId(options.limitId) : undefined;
	const explicitlyBlocked =
		observation?.limits.filter(
			(limit) =>
				limit.allowed === false ||
				limit.limitReached === true ||
				limit.spendControl?.reached === true,
		) ?? [];
	const inferredLimit = explicitlyBlocked.length === 1 ? explicitlyBlocked[0]?.limitId : undefined;
	const effectiveLimit = requestedLimit ?? inferredLimit;
	const selectedLimits = observation
		? effectiveLimit
			? observation.limits.filter((limit) => limit.limitId === effectiveLimit)
			: explicitlyBlocked.length > 0
				? explicitlyBlocked
				: observation.limits.filter((limit) => limit.limitId === "codex")
		: [];
	const limits = selectedLimits.length > 0 ? selectedLimits : (observation?.limits ?? []);
	const exhaustedWindows: ExhaustedWindow[] = [];
	for (const limit of limits) {
		for (const window of [limit.primary, limit.secondary]) {
			if (!window || window.usedPercent < EXHAUSTED_PERCENT) continue;
			exhaustedWindows.push({
				limitId: limit.limitId,
				kind: window.kind,
				position: window.position,
				...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
			});
		}
	}
	const resetCandidates = [
		options.resetAt,
		...exhaustedWindows.map((window) => window.resetAt),
		...limits.map((limit) => limit.spendControl?.resetAt),
	].filter(
		(value): value is number =>
			value !== undefined && Number.isFinite(value) && value > observedAt,
	);
	const resetAt = resetCandidates.length > 0 ? Math.max(...resetCandidates) : undefined;
	const kind = observation ? inferHardStopKind(observation, options.kind) : options.kind;
	return {
		kind,
		observedAt,
		exhaustedWindows,
		...(resetAt !== undefined ? { resetAt } : {}),
		...(effectiveLimit ? { limitId: effectiveLimit } : {}),
		...(options.modelId ? { modelId: options.modelId } : {}),
		...(options.reason ? { reason: options.reason.slice(0, 300) } : {}),
	};
}

export function findWindow(
	limits: Record<string, LimitSnapshot>,
	kind: "five_hour" | "weekly",
): UsageWindowSnapshot | undefined {
	const base = limits.codex;
	if (!base) return undefined;
	return [base.primary, base.secondary]
		.filter((window): window is UsageWindowSnapshot => window !== undefined && window.kind === kind)
		.sort((left, right) => right.observedAt - left.observedAt)[0];
}
