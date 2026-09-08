import type { AuthResult, ProviderEnv } from "@earendil-works/pi-ai";

export const PACKAGE_VERSION = "0.2.0";
export const CONFIG_VERSION = 1 as const;
export const STATE_VERSION = 1 as const;
export const BUILTIN_CODEX_PROVIDER_ID = "openai-codex";
export const DEFAULT_POOL_PROVIDER_ID = "openai-codex-ring";
export const AUTH_PROVIDER_PREFIX = "openai-codex-ring-auth-";
export const RING_DIAGNOSTIC_TYPE = "pi-codex-ring-account-v1";

export interface RingAccountConfig {
	id: string;
	label: string;
	enabled: boolean;
	useBuiltinProvider: boolean;
	authProviderId: string;
}

export interface RingConfig {
	version: typeof CONFIG_VERSION;
	providerId: string;
	accounts: RingAccountConfig[];
	usagePollTtlMs: number;
	usagePollTimeoutMs: number;
	unknownResetRetryMs: number;
	statusStaleMs: number;
}

export interface LoadedRingConfig {
	config: RingConfig;
	path: string;
	exists: boolean;
	warnings: string[];
}

export interface JwtIdentity {
	accountId: string;
	userId?: string;
	planType?: string;
	fingerprint: string;
}

export interface ResolvedAccount {
	slot: RingAccountConfig;
	index: number;
	auth: AuthResult;
	apiKey: string;
	identity: JwtIdentity;
	env?: ProviderEnv;
	duplicateOf?: string;
}

export type WindowKind = "five_hour" | "weekly" | "other";
export type QuotaSource = "usage_endpoint" | "response_headers" | "request_error";

export interface UsageWindowSnapshot {
	position: "primary" | "secondary";
	kind: WindowKind;
	usedPercent: number;
	windowMinutes?: number;
	resetAt?: number;
	observedAt: number;
	source: QuotaSource;
}

export interface CreditsSnapshot {
	hasCredits?: boolean;
	unlimited?: boolean;
	balance?: string;
}

export interface SpendControlSnapshot {
	reached?: boolean;
	remainingPercent?: number;
	resetAt?: number;
}

export interface LimitSnapshot {
	limitId: string;
	limitName?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: UsageWindowSnapshot;
	secondary?: UsageWindowSnapshot;
	credits?: CreditsSnapshot;
	spendControl?: SpendControlSnapshot;
}

export interface QuotaObservation {
	observedAt: number;
	source: QuotaSource;
	planType?: string;
	rateLimitReachedType?: string;
	limits: LimitSnapshot[];
}

export type HardStopKind =
	| "usage_limit"
	| "usage_not_included"
	| "credits_depleted"
	| "spend_cap"
	| "endpoint_hard_stop"
	| "unknown";

export interface ExhaustedWindow {
	limitId: string;
	kind: WindowKind;
	position?: "primary" | "secondary";
	resetAt?: number;
}

export interface HardStop {
	kind: HardStopKind;
	observedAt: number;
	resetAt?: number;
	exhaustedWindows: ExhaustedWindow[];
	limitId?: string;
	modelId?: string;
	reason?: string;
}

export interface PersistedAccountState {
	fingerprint: string;
	planType?: string;
	limits: Record<string, LimitSnapshot>;
	hardStop?: HardStop;
	modelBlocks: Record<string, HardStop>;
	lastObservedAt?: number;
	lastPollAt?: number;
	lastSuccessfulRequestAt?: number;
}

export interface PersistedSlotState {
	fingerprint: string;
	lastSeenAt: number;
}

export interface PersistedRingState {
	version: typeof STATE_VERSION;
	updatedAt: number;
	accounts: Record<string, PersistedAccountState>;
	slots: Record<string, PersistedSlotState>;
}

export interface CapturedHttpError {
	status: number;
	observedAt: number;
	code?: string;
	type?: string;
	message?: string;
	planType?: string;
	resetAt?: number;
	activeLimit?: string;
	rateLimitReachedType?: string;
}

export interface AttemptCapture {
	httpError?: CapturedHttpError;
	lastHeaderObservation?: QuotaObservation;
}

export type PollFailureKind = "aborted" | "unauthorized" | "http" | "network" | "invalid_payload";

export interface PollSuccess {
	ok: true;
	observation: QuotaObservation;
}

export interface PollFailure {
	ok: false;
	kind: PollFailureKind;
	status?: number;
	message: string;
}

export type PollResult = PollSuccess | PollFailure;

export type AccountAvailability =
	| { kind: "eligible" }
	| { kind: "probe_needed"; hardStop: HardStop }
	| { kind: "blocked"; hardStop: HardStop };

export type RingMode = { type: "auto" } | { type: "force"; accountId: string };

export interface RingSessionState {
	cursor: number;
	mode: RingMode;
	activeAccountId?: string;
	activeFingerprint?: string;
}

export type FailureClassification =
	| { kind: "usage_limit"; resetAt?: number; limitId?: string; reachedType?: string }
	| { kind: "usage_not_included" }
	| { kind: "auth" }
	| { kind: "transient_rate_limit"; message?: string }
	| { kind: "aborted" }
	| { kind: "other" };

export interface StatusRow {
	id: string;
	label: string;
	authProviderId: string;
	enabled: boolean;
	authConfigured: boolean;
	active: boolean;
	forced: boolean;
	duplicateOf?: string;
	fingerprint?: string;
	state?: PersistedAccountState;
	authError?: string;
}

export function emptyRingState(now = Date.now()): PersistedRingState {
	return {
		version: STATE_VERSION,
		updatedAt: now,
		accounts: {},
		slots: {},
	};
}

export function emptyAccountState(fingerprint: string): PersistedAccountState {
	return {
		fingerprint,
		limits: {},
		modelBlocks: {},
	};
}
