import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { hardStopsFromObservation } from "./quota.ts";
import {
	emptyAccountState,
	emptyRingState,
	STATE_VERSION,
	type AccountAvailability,
	type HardStop,
	type LimitSnapshot,
	type PersistedAccountState,
	type PersistedRingState,
	type QuotaObservation,
	type UsageWindowSnapshot,
} from "./types.ts";

const FINGERPRINT_PATTERN = /^[a-f0-9]{24}$/;
const SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_RECORD_KEY_PATTERN = /^[a-z0-9_]{1,128}$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isWindow(value: unknown): value is UsageWindowSnapshot {
	if (!isObject(value)) return false;
	return (
		(value.position === "primary" || value.position === "secondary") &&
		(value.kind === "five_hour" || value.kind === "weekly" || value.kind === "other") &&
		isFiniteNumber(value.usedPercent) &&
		isFiniteNumber(value.observedAt) &&
		(value.source === "usage_endpoint" || value.source === "response_headers" || value.source === "request_error") &&
		(value.windowMinutes === undefined || isFiniteNumber(value.windowMinutes)) &&
		(value.resetAt === undefined || isFiniteNumber(value.resetAt))
	);
}

function isShortString(value: unknown, maximum = 256): value is string {
	return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function isLimit(value: unknown): value is LimitSnapshot {
	if (!isObject(value) || typeof value.limitId !== "string") return false;
	const credits = value.credits;
	if (
		credits !== undefined &&
		(!isObject(credits) ||
			(credits.hasCredits !== undefined && typeof credits.hasCredits !== "boolean") ||
			(credits.unlimited !== undefined && typeof credits.unlimited !== "boolean") ||
			(credits.balance !== undefined && !isShortString(credits.balance)))
	) return false;
	const spend = value.spendControl;
	if (
		spend !== undefined &&
		(!isObject(spend) ||
			(spend.reached !== undefined && typeof spend.reached !== "boolean") ||
			(spend.limit !== undefined && !isShortString(spend.limit)) ||
			(spend.used !== undefined && !isShortString(spend.used)) ||
			(spend.remaining !== undefined && !isShortString(spend.remaining)) ||
			(spend.remainingPercent !== undefined && !isFiniteNumber(spend.remainingPercent)) ||
			(spend.resetAt !== undefined && !isFiniteNumber(spend.resetAt)))
	) return false;
	return (
		(value.limitName === undefined || isShortString(value.limitName)) &&
		(value.planType === undefined || isShortString(value.planType)) &&
		(value.primary === undefined || isWindow(value.primary)) &&
		(value.secondary === undefined || isWindow(value.secondary)) &&
		(value.allowed === undefined || typeof value.allowed === "boolean") &&
		(value.limitReached === undefined || typeof value.limitReached === "boolean")
	);
}

function isHardStop(value: unknown): value is HardStop {
	if (!isObject(value) || !isFiniteNumber(value.observedAt) || !Array.isArray(value.exhaustedWindows)) return false;
	const windowsValid = value.exhaustedWindows.every(
		(window) =>
			isObject(window) &&
			isShortString(window.limitId, 128) &&
			(window.kind === "five_hour" || window.kind === "weekly" || window.kind === "other") &&
			(window.position === undefined || window.position === "primary" || window.position === "secondary") &&
			(window.resetAt === undefined || isFiniteNumber(window.resetAt)),
	);
	return (
		windowsValid &&
		[
			"usage_limit",
			"usage_not_included",
			"credits_depleted",
			"spend_cap",
			"endpoint_hard_stop",
			"unknown",
		].includes(String(value.kind)) &&
		(value.resetAt === undefined || isFiniteNumber(value.resetAt)) &&
		(value.limitId === undefined || isShortString(value.limitId, 128)) &&
		(value.modelId === undefined || isShortString(value.modelId)) &&
		(value.reason === undefined || isShortString(value.reason, 300))
	);
}

function isAccountState(value: unknown, fingerprint: string): value is PersistedAccountState {
	if (!isObject(value) || value.fingerprint !== fingerprint || !isObject(value.limits) || !isObject(value.modelBlocks)) {
		return false;
	}
	if (
		!Object.entries(value.limits).every(
			([key, limit]) => SAFE_RECORD_KEY_PATTERN.test(key) && isLimit(limit) && limit.limitId === key,
		)
	) return false;
	if (
		!Object.entries(value.modelBlocks).every(
			([key, stop]) =>
				key.length > 0 &&
				key.length <= 256 &&
				key !== "__proto__" &&
				key !== "prototype" &&
				key !== "constructor" &&
				isHardStop(stop),
		)
	) return false;
	return (
		(value.planType === undefined || isShortString(value.planType)) &&
		(value.lastObservedAt === undefined || isFiniteNumber(value.lastObservedAt)) &&
		(value.lastPollAt === undefined || isFiniteNumber(value.lastPollAt)) &&
		(value.lastSuccessfulRequestAt === undefined || isFiniteNumber(value.lastSuccessfulRequestAt)) &&
		(value.hardStop === undefined || isHardStop(value.hardStop))
	);
}

export function parsePersistedState(value: unknown): PersistedRingState {
	if (!isObject(value) || value.version !== STATE_VERSION || !isObject(value.accounts) || !isObject(value.slots)) {
		throw new Error(`state must use schema version ${STATE_VERSION}`);
	}
	const accounts: Record<string, PersistedAccountState> = {};
	for (const [fingerprint, account] of Object.entries(value.accounts)) {
		if (!FINGERPRINT_PATTERN.test(fingerprint) || !isAccountState(account, fingerprint)) {
			throw new Error(`invalid account state for ${fingerprint.slice(0, 24)}`);
		}
		accounts[fingerprint] = structuredClone(account);
	}
	const slots: PersistedRingState["slots"] = {};
	for (const [slotId, slot] of Object.entries(value.slots)) {
		if (
			!isObject(slot) ||
			!FINGERPRINT_PATTERN.test(String(slot.fingerprint)) ||
			!isFiniteNumber(slot.lastSeenAt) ||
			!SLOT_ID_PATTERN.test(slotId)
		) {
			throw new Error(`invalid slot state for ${slotId.slice(0, 128)}`);
		}
		slots[slotId] = { fingerprint: String(slot.fingerprint), lastSeenAt: slot.lastSeenAt };
	}
	return {
		version: STATE_VERSION,
		updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : Date.now(),
		accounts,
		slots,
	};
}

function mergeWindow(
	current: UsageWindowSnapshot | undefined,
	next: UsageWindowSnapshot | undefined,
): UsageWindowSnapshot | undefined {
	if (!next) return current;
	if (!current || next.observedAt >= current.observedAt) return structuredClone(next);
	return current;
}

function mergeLimit(current: LimitSnapshot | undefined, next: LimitSnapshot): LimitSnapshot {
	const primary = mergeWindow(current?.primary, next.primary);
	const secondary = mergeWindow(current?.secondary, next.secondary);
	const merged: LimitSnapshot = {
		...(current ?? { limitId: next.limitId }),
		...next,
	};
	if (primary) merged.primary = primary;
	else delete merged.primary;
	if (secondary) merged.secondary = secondary;
	else delete merged.secondary;
	return merged;
}

function observationExplicitlyAvailable(observation: QuotaObservation, hardStop: HardStop): boolean {
	if (
		observation.source !== "usage_endpoint" ||
		observation.rateLimitReachedType ||
		hardStop.kind === "usage_not_included"
	) return false;
	const relevant = hardStop.limitId
		? observation.limits.filter((limit) => limit.limitId === hardStop.limitId)
		: observation.limits.filter((limit) => limit.limitId === "codex");
	if (relevant.length === 0) return false;
	return relevant.every(
		(limit) =>
			limit.allowed === true &&
			limit.limitReached !== true &&
			limit.spendControl?.reached !== true,
	);
}

export function mergeObservation(
	account: PersistedAccountState,
	observation: QuotaObservation,
	options: { allowClear: boolean; recordHardStop: boolean },
): PersistedAccountState {
	const next = structuredClone(account);
	if (next.lastObservedAt !== undefined && observation.observedAt < next.lastObservedAt) return next;
	for (const limit of observation.limits) {
		next.limits[limit.limitId] = mergeLimit(next.limits[limit.limitId], limit);
	}
	if (observation.planType) next.planType = observation.planType;
	next.lastObservedAt = observation.observedAt;
	if (observation.source === "usage_endpoint") next.lastPollAt = observation.observedAt;

	if (options.recordHardStop) {
		for (const hardStop of hardStopsFromObservation(observation)) {
			if (hardStop.modelId) {
				const current = next.modelBlocks[hardStop.modelId];
				if (!current || hardStop.observedAt >= current.observedAt) {
					next.modelBlocks[hardStop.modelId] = hardStop;
				}
			} else if (!next.hardStop || hardStop.observedAt >= next.hardStop.observedAt) {
				next.hardStop = hardStop;
			}
		}
	}
	if (
		options.allowClear &&
		next.hardStop &&
		observation.observedAt > next.hardStop.observedAt &&
		observationExplicitlyAvailable(observation, next.hardStop)
	) {
		delete next.hardStop;
	}

	if (options.allowClear && observation.source === "usage_endpoint") {
		for (const [modelId, block] of Object.entries(next.modelBlocks)) {
			if (observation.observedAt <= block.observedAt) continue;
			if (observationExplicitlyAvailable(observation, block)) delete next.modelBlocks[modelId];
		}
	}
	return next;
}

export function accountAvailability(
	account: PersistedAccountState | undefined,
	modelId: string,
	now: number,
	unknownResetRetryMs: number,
): AccountAvailability {
	const hardStop = account?.modelBlocks[modelId] ?? account?.hardStop;
	if (!hardStop) return { kind: "eligible" };
	if (
		hardStop.resetAt === undefined &&
		(hardStop.kind === "credits_depleted" ||
			hardStop.kind === "spend_cap" ||
			hardStop.kind === "usage_not_included")
	) {
		return { kind: "blocked", hardStop };
	}
	const retryAt = hardStop.resetAt ?? hardStop.observedAt + unknownResetRetryMs;
	return now >= retryAt ? { kind: "probe_needed", hardStop } : { kind: "blocked", hardStop };
}

export class StateStore {
	private cache: PersistedRingState = emptyRingState();
	private initialized = false;
	readonly warnings: string[] = [];

	constructor(readonly path: string) {}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		try {
			const handle = await open(this.path, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(emptyRingState(), null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		try {
			this.cache = await this.readDiskWithRetry();
		} catch {
			await this.quarantineCorruptState();
			this.warnings.push(`Quarantined corrupt Codex ring state at ${this.path}`);
			await this.writeAtomic(emptyRingState());
			this.cache = emptyRingState();
		}
		await chmod(this.path, 0o600);
		this.initialized = true;
	}

	snapshot(): PersistedRingState {
		return structuredClone(this.cache);
	}

	async refresh(): Promise<PersistedRingState> {
		await this.initialize();
		try {
			this.cache = await this.readDisk();
		} catch {
			// Keep the last good in-memory snapshot. The next locked update will
			// quarantine and replace a corrupt file.
		}
		return this.snapshot();
	}

	async update(mutator: (state: PersistedRingState) => void): Promise<PersistedRingState> {
		await this.initialize();
		const release = await lockfile.lock(this.path, {
			realpath: false,
			stale: 15_000,
			update: 5_000,
			retries: { retries: 6, factor: 1.5, minTimeout: 20, maxTimeout: 500 },
		});
		try {
			let state: PersistedRingState;
			try {
				state = await this.readDisk();
			} catch {
				await this.quarantineCorruptState();
				this.warnings.push(`Quarantined corrupt Codex ring state at ${this.path}`);
				state = emptyRingState();
			}
			mutator(state);
			state.updatedAt = Date.now();
			await this.writeAtomic(state);
			this.cache = state;
			return this.snapshot();
		} finally {
			await release();
		}
	}

	async rememberAccount(slotId: string, fingerprint: string, observedAt = Date.now()): Promise<void> {
		await this.rememberAccounts([{ slotId, fingerprint, observedAt }]);
	}

	async rememberAccounts(entries: Array<{ slotId: string; fingerprint: string; observedAt: number }>): Promise<void> {
		if (entries.length === 0) return;
		await this.update((state) => {
			for (const entry of entries) {
				state.slots[entry.slotId] = { fingerprint: entry.fingerprint, lastSeenAt: entry.observedAt };
				state.accounts[entry.fingerprint] ??= emptyAccountState(entry.fingerprint);
			}
		});
	}

	async applyObservation(
		slotId: string,
		fingerprint: string,
		observation: QuotaObservation,
		options: { allowClear?: boolean; recordHardStop?: boolean } = {},
	): Promise<void> {
		await this.update((state) => {
			state.slots[slotId] = { fingerprint, lastSeenAt: observation.observedAt };
			const current = state.accounts[fingerprint] ?? emptyAccountState(fingerprint);
			state.accounts[fingerprint] = mergeObservation(current, observation, {
				allowClear: options.allowClear ?? true,
				recordHardStop: options.recordHardStop ?? true,
			});
		});
	}

	async setHardStop(slotId: string, fingerprint: string, hardStop: HardStop): Promise<void> {
		await this.update((state) => {
			state.slots[slotId] = { fingerprint, lastSeenAt: hardStop.observedAt };
			const account = (state.accounts[fingerprint] ??= emptyAccountState(fingerprint));
			if (hardStop.modelId) {
				const current = account.modelBlocks[hardStop.modelId];
				if (!current || hardStop.observedAt >= current.observedAt) account.modelBlocks[hardStop.modelId] = hardStop;
			} else if (!account.hardStop || hardStop.observedAt >= account.hardStop.observedAt) {
				account.hardStop = hardStop;
			}
		});
	}

	async markSuccess(slotId: string, fingerprint: string, at = Date.now()): Promise<void> {
		await this.update((state) => {
			state.slots[slotId] = { fingerprint, lastSeenAt: at };
			const account = (state.accounts[fingerprint] ??= emptyAccountState(fingerprint));
			account.lastSuccessfulRequestAt = Math.max(account.lastSuccessfulRequestAt ?? 0, at);
		});
	}

	async clearForSlot(slotId: string): Promise<boolean> {
		let cleared = false;
		await this.update((state) => {
			const fingerprint = state.slots[slotId]?.fingerprint;
			if (!fingerprint) return;
			const account = state.accounts[fingerprint];
			if (!account) return;
			cleared = Boolean(account.hardStop || Object.keys(account.modelBlocks).length > 0);
			delete account.hardStop;
			account.modelBlocks = {};
		});
		return cleared;
	}

	private async readDisk(): Promise<PersistedRingState> {
		const info = await stat(this.path);
		if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error("invalid state file");
		return parsePersistedState(JSON.parse(await readFile(this.path, "utf8")));
	}

	private async readDiskWithRetry(): Promise<PersistedRingState> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await this.readDisk();
			} catch (error) {
				lastError = error;
				if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
			}
		}
		throw lastError;
	}

	private async writeAtomic(state: PersistedRingState): Promise<void> {
		const temp = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temp, this.path);
		} catch (error) {
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	private async quarantineCorruptState(): Promise<void> {
		try {
			const quarantined = `${this.path}.corrupt-${Date.now()}`;
			await rename(this.path, quarantined);
			await chmod(quarantined, 0o600);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
	}
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
