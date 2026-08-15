import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type FetchFunction,
	type Model,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fingerprintSecret, identifyAccount, mergeHeaders, sanitizeErrorMessage } from "./account.ts";
import { createBuiltinCodexProvider } from "./codex-provider.ts";
import {
	adaptContext,
	decorateAssistantMessage,
	decorateEvent,
	eventHasMeaningfulOutput,
} from "./context.ts";
import { classifyFailure, normalizeTransientRateLimitMessage } from "./errors.ts";
import {
	buildHardStop,
	observationHasHardStop,
	parseCapturedHttpError,
	parseRateLimitHeaders,
} from "./quota.ts";
import { accountAvailability, StateStore } from "./state.ts";
import {
	BUILTIN_CODEX_PROVIDER_ID,
	emptyAccountState,
	type AttemptCapture,
	type FailureClassification,
	type HardStop,
	type PersistedAccountState,
	type PollResult,
	type QuotaObservation,
	type ResolvedAccount,
	type RingConfig,
	type RingMode,
	type RingSessionState,
	type StatusRow,
} from "./types.ts";
import { UsageClient, type UsagePoller } from "./usage-client.ts";

interface AccountResolution {
	index: number;
	slotId: string;
	configured: boolean;
	account?: ResolvedAccount;
	error?: string;
}

interface SelectedAccount {
	resolution: AccountResolution;
	account: ResolvedAccount;
}

export interface RingRouterHooks {
	onSwitch?(from: ResolvedAccount, to: ResolvedAccount, hardStop: HardStop): void;
	onStateChange?(): void;
	onWarning?(message: string): void;
}

export interface RingRouterDependencies {
	usageClient?: UsagePoller;
	baseProvider?: Provider<"openai-codex-responses">;
}

interface FailureStateResult {
	hardStop?: HardStop;
	pollObservation?: QuotaObservation;
}

interface RouteOptions {
	simple: boolean;
	options?: StreamOptions | SimpleStreamOptions;
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function syntheticMessage(
	model: Model<"openai-codex-responses">,
	stopReason: "error" | "aborted",
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

async function readResponseClone(response: Response): Promise<unknown> {
	const clone = response.clone();
	if (!clone.body) return undefined;
	const reader = clone.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_ERROR_BODY_BYTES) throw new Error("provider error body is too large");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Ignore clone cleanup errors.
		}
	}
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function createObservedFetch(
	upstream: FetchFunction,
	capture: AttemptCapture,
	onObservation: (observation: QuotaObservation) => void,
): FetchFunction {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const response = await upstream(input, init);
		const observedAt = Date.now();
		const observation = parseRateLimitHeaders(response.headers, observedAt);
		if (observation) {
			capture.lastHeaderObservation = observation;
			onObservation(observation);
		}
		if (response.ok) {
			delete capture.httpError;
			return response;
		}
		let body: unknown;
		try {
			body = await readResponseClone(response);
		} catch {
			// Status and headers still provide useful classification.
		}
		capture.httpError = parseCapturedHttpError(response.status, body, response.headers, observedAt);
		return response;
	}) as FetchFunction;
}

function combineEnv(
	base: Record<string, string> | undefined,
	override: Record<string, string> | undefined,
): Record<string, string> | undefined {
	return base || override ? { ...(base ?? {}), ...(override ?? {}) } : undefined;
}

function hardStopSummary(stop: HardStop): string {
	if (stop.resetAt !== undefined) return `cooldown until ${new Date(stop.resetAt).toLocaleString()}`;
	switch (stop.kind) {
		case "credits_depleted":
			return "workspace credits depleted";
		case "spend_cap":
			return "workspace spend cap reached";
		case "usage_not_included":
			return "selected model is not included";
		default:
			return "cooldown pending a server probe";
	}
}

function isSwitchable(classification: FailureClassification): boolean {
	return classification.kind === "usage_limit" || classification.kind === "usage_not_included" || classification.kind === "auth";
}

function observationExplicitlyAllowsRequests(observation: QuotaObservation): boolean {
	if (observation.source !== "usage_endpoint" || observation.rateLimitReachedType) return false;
	const base = observation.limits.find((limit) => limit.limitId === "codex");
	return (
		base?.allowed === true &&
		base.limitReached !== true &&
		base.spendControl?.reached !== true
	);
}

export class RingRouter {
	private readonly baseProvider: Provider<"openai-codex-responses">;
	private readonly usageClient: UsagePoller;
	private registry?: ModelRegistry;
	private sessionAbort = new AbortController();
	private readonly pollInFlight = new Map<string, Promise<PollResult>>();
	private readonly authErrors = new Map<string, string>();
	private readonly authRejectedSlots = new Set<string>();
	private readonly tokenFingerprints = new Map<string, string>();
	private readonly duplicateSlots = new Map<string, string>();
	private readonly knownFingerprints = new Map<string, string>();
	private readonly runtimeStops = new Map<string, HardStop>();
	private readonly runtimeModelStops = new Map<string, Map<string, HardStop>>();
	private readonly backgroundTasks = new Set<Promise<void>>();
	private session: RingSessionState = { cursor: 0, mode: { type: "auto" } };

	constructor(
		readonly config: RingConfig,
		readonly store: StateStore,
		private readonly hooks: RingRouterHooks = {},
		dependencies: RingRouterDependencies = {},
	) {
		this.baseProvider = dependencies.baseProvider ?? createBuiltinCodexProvider();
		this.usageClient = dependencies.usageClient ?? new UsageClient(config.usagePollTimeoutMs);
	}

	bindRegistry(registry: ModelRegistry): void {
		this.registry = registry;
	}

	startSession(): void {
		if (this.sessionAbort.signal.aborted) this.sessionAbort = new AbortController();
		this.session = { cursor: 0, mode: { type: "auto" } };
	}

	async shutdown(): Promise<void> {
		this.sessionAbort.abort();
		while (this.backgroundTasks.size > 0) {
			await Promise.all([...this.backgroundTasks]);
		}
		await this.usageClient.close();
	}

	stream(
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		return this.route(model, context, { simple: false, ...(options ? { options } : {}) });
	}

	streamSimple(
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		return this.route(model, context, { simple: true, ...(options ? { options } : {}) });
	}

	get mode(): RingMode {
		return structuredClone(this.session.mode);
	}

	setAutoMode(): void {
		this.session.mode = { type: "auto" };
		this.hooks.onStateChange?.();
	}

	forceAccount(accountId: string): boolean {
		const index = this.config.accounts.findIndex((account) => account.id === accountId && account.enabled);
		if (index < 0) return false;
		this.session.mode = { type: "force", accountId };
		this.session.cursor = index;
		this.session.activeAccountId = accountId;
		delete this.session.activeFingerprint;
		this.hooks.onStateChange?.();
		return true;
	}

	next(): string | undefined {
		const enabled = this.config.accounts.filter((account) => account.enabled);
		if (enabled.length === 0) return undefined;
		const currentIndex = this.session.activeAccountId
			? this.config.accounts.findIndex((account) => account.id === this.session.activeAccountId)
			: this.session.cursor;
		for (let offset = 1; offset <= this.config.accounts.length; offset++) {
			const index = (Math.max(0, currentIndex) + offset) % this.config.accounts.length;
			const account = this.config.accounts[index];
			if (!account?.enabled) continue;
			this.session.cursor = index;
			this.session.mode = { type: "auto" };
			delete this.session.activeAccountId;
			delete this.session.activeFingerprint;
			this.hooks.onStateChange?.();
			return account.id;
		}
		return undefined;
	}

	async clear(accountId: string): Promise<boolean> {
		const slot = this.config.accounts.find((account) => account.id === accountId);
		if (!slot) return false;
		const fingerprint = this.knownFingerprints.get(slot.id) ?? this.store.snapshot().slots[slot.id]?.fingerprint;
		if (fingerprint) {
			this.runtimeStops.delete(fingerprint);
			this.runtimeModelStops.delete(fingerprint);
		}
		this.authErrors.delete(slot.id);
		this.authRejectedSlots.delete(slot.id);
		const cleared = await this.store.clearForSlot(slot.id).catch((error) => {
			this.warn(`Could not clear persisted state: ${sanitizeErrorMessage(error)}`);
			return false;
		});
		this.hooks.onStateChange?.();
		return cleared || fingerprint !== undefined;
	}

	async refreshAll(signal?: AbortSignal): Promise<void> {
		const resolutions = await this.resolveAccounts(signal);
		const queue = resolutions.filter((entry): entry is AccountResolution & { account: ResolvedAccount } => Boolean(entry.account));
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < queue.length) {
				const entry = queue[cursor++];
				if (!entry || entry.account.duplicateOf) continue;
				await this.pollAccount(entry.account, this.accountBaseUrl(entry.account), {
					allowClear: true,
					recordHardStop: true,
					...(signal ? { signal } : {}),
				});
			}
		};
		await Promise.all([worker(), worker()]);
		await this.store.refresh();
		this.hooks.onStateChange?.();
	}

	statusRows(): StatusRow[] {
		const snapshot = this.store.snapshot();
		return this.config.accounts.map((slot) => {
			const fingerprint = this.knownFingerprints.get(slot.id) ?? snapshot.slots[slot.id]?.fingerprint;
			const persisted = fingerprint ? snapshot.accounts[fingerprint] : undefined;
			const state = fingerprint ? this.effectiveState(fingerprint, persisted) : undefined;
			const duplicateOf = this.duplicateSlots.get(slot.id);
			const authError = this.authErrors.get(slot.id);
			const authConfigured = this.registry?.getProviderAuthStatus(slot.authProviderId).configured ?? false;
			return {
				id: slot.id,
				label: slot.label,
				authProviderId: slot.authProviderId,
				enabled: slot.enabled,
				authConfigured,
				active: this.session.activeAccountId === slot.id,
				forced: this.session.mode.type === "force" && this.session.mode.accountId === slot.id,
				...(duplicateOf ? { duplicateOf } : {}),
				...(fingerprint ? { fingerprint } : {}),
				...(state ? { state } : {}),
				...(authError ? { authError } : {}),
			};
		});
	}

	private route(
		model: Model<"openai-codex-responses">,
		context: Context,
		routeOptions: RouteOptions,
	): AssistantMessageEventStream {
		const outer = createAssistantMessageEventStream();
		void this.runRoute(outer, model, context, routeOptions).catch((error) => {
			const aborted = routeOptions.options?.signal?.aborted === true;
			this.emitSyntheticError(
				outer,
				model,
				aborted ? "aborted" : "error",
				aborted ? "Request was aborted" : `Codex ring failed: ${sanitizeErrorMessage(error)}`,
			);
		});
		return outer;
	}

	private async runRoute(
		outer: AssistantMessageEventStream,
		model: Model<"openai-codex-responses">,
		context: Context,
		routeOptions: RouteOptions,
	): Promise<void> {
		if (!this.registry) {
			this.emitSyntheticError(outer, model, "error", "Codex ring has not been bound to a Pi session");
			return;
		}
		const signal = routeOptions.options?.signal;
		if (signal?.aborted) {
			this.emitSyntheticError(outer, model, "aborted", "Request was aborted");
			return;
		}
		const resolutions = await this.resolveAccounts(signal);
		const tried = new Set<number>();
		let pendingSwitch: { from: ResolvedAccount; hardStop: HardStop } | undefined;
		let attempt = 0;

		while (tried.size < this.config.accounts.length) {
			if (signal?.aborted) {
				this.emitSyntheticError(outer, model, "aborted", "Request was aborted");
				return;
			}
			const selected = await this.selectAccount(
				resolutions,
				tried,
				model,
				signal,
				routeOptions.options?.env,
			);
			if (!selected) {
				this.emitSyntheticError(outer, model, "error", this.unavailableMessage(resolutions, model.id));
				return;
			}
			const account = this.withRequestEnv(selected.account, routeOptions.options?.env);
			if (pendingSwitch && pendingSwitch.from.slot.id !== account.slot.id) {
				this.hooks.onSwitch?.(pendingSwitch.from, account, pendingSwitch.hardStop);
				pendingSwitch = undefined;
			}
			attempt++;
			const attemptStarted = Date.now();
			const capture: AttemptCapture = {};
			const delegatedModel: Model<"openai-codex-responses"> = {
				...model,
				provider: BUILTIN_CODEX_PROVIDER_ID,
				baseUrl: account.auth.auth.baseUrl ?? model.baseUrl,
			};
			const adaptedContext = adaptContext(context, account, this.config.providerId);
			const requestOptions = this.delegateOptions(account, routeOptions.options, capture);
			let inner: AssistantMessageEventStream;
			try {
				inner = routeOptions.simple
					? this.baseProvider.streamSimple(delegatedModel, adaptedContext, requestOptions as SimpleStreamOptions)
					: this.baseProvider.stream(delegatedModel, adaptedContext, requestOptions as StreamOptions);
			} catch (error) {
				const terminal = syntheticMessage(
					model,
					signal?.aborted ? "aborted" : "error",
					sanitizeErrorMessage(error),
				);
				const classification = classifyFailure(terminal, capture);
				if (isSwitchable(classification) && !signal?.aborted && this.session.mode.type === "auto") {
					const failure = await this.recordFailure(account, delegatedModel, classification, capture, undefined, true, signal);
					tried.add(selected.resolution.index);
					this.session.cursor = (selected.resolution.index + 1) % this.config.accounts.length;
					pendingSwitch = {
						from: account,
						hardStop:
							failure.hardStop ??
							buildHardStop(undefined, { kind: "unknown", reason: "Authentication unavailable" }),
					};
					continue;
				}
				this.emitSyntheticError(outer, model, terminal.stopReason === "aborted" ? "aborted" : "error", terminal.errorMessage ?? "Codex request failed");
				return;
			}

			const buffered: AssistantMessageEvent[] = [];
			let committed = false;
			let terminalRaw: AssistantMessage | undefined;
			let terminalDecorated: AssistantMessage | undefined;
			try {
				for await (const event of inner) {
					const decorated = decorateEvent(event, account, this.config.providerId, attempt, attemptStarted);
					if (event.type === "done") {
						for (const pending of buffered) outer.push(pending);
						outer.push(decorated);
						this.recordSuccess(account, selected.resolution.index, delegatedModel.baseUrl);
						return;
					}
					if (event.type === "error") {
						terminalRaw = event.error;
						if (decorated.type !== "error") throw new Error("Codex ring event rewrite mismatch");
						terminalDecorated = decorated.error;
						break;
					}
					if (eventHasMeaningfulOutput(event)) {
						if (!committed) {
							for (const pending of buffered) outer.push(pending);
							buffered.length = 0;
							committed = true;
						}
						outer.push(decorated);
					} else if (committed) {
						outer.push(decorated);
					} else {
						buffered.push(decorated);
					}
				}
			} catch (error) {
				terminalRaw = syntheticMessage(
					delegatedModel,
					signal?.aborted ? "aborted" : "error",
					sanitizeErrorMessage(error),
				);
				terminalDecorated = decorateAssistantMessage(
					terminalRaw,
					account,
					this.config.providerId,
					attempt,
					attemptStarted,
				);
			}
			if (!terminalRaw || !terminalDecorated) {
				terminalRaw = syntheticMessage(delegatedModel, "error", "Codex stream ended without a terminal event");
				terminalDecorated = decorateAssistantMessage(
					terminalRaw,
					account,
					this.config.providerId,
					attempt,
					attemptStarted,
				);
			}

			let preliminaryPoll: QuotaObservation | undefined;
			const capturedCode = (capture.httpError?.code ?? capture.httpError?.type ?? "").toLowerCase();
			const ambiguousHttpThrottle =
				capture.httpError?.status === 429 &&
				(capturedCode === "" || capturedCode === "rate_limit_exceeded");
			if (
				!committed &&
				(!capture.httpError || ambiguousHttpThrottle) &&
				!signal?.aborted &&
				/(?:usage|quota|credits|spend|rate.?limit)/i.test(terminalRaw.errorMessage ?? "")
			) {
				const result = await this.pollAccount(account, delegatedModel.baseUrl, {
					allowClear: false,
					recordHardStop: false,
					...(signal ? { signal } : {}),
				});
				if (result.ok) preliminaryPoll = result.observation;
			}
			const classification = classifyFailure(terminalRaw, capture, preliminaryPoll);
			let failureState: FailureStateResult = {};
			if (isSwitchable(classification)) {
				failureState = await this.recordFailure(
					account,
					delegatedModel,
					classification,
					capture,
					preliminaryPoll,
					!committed,
					signal,
				);
				if (this.session.mode.type === "auto") {
					this.session.cursor = (selected.resolution.index + 1) % this.config.accounts.length;
				}
			}

			const canFailOver =
				!committed &&
				!signal?.aborted &&
				this.session.mode.type === "auto" &&
				isSwitchable(classification);
			if (canFailOver) {
				tried.add(selected.resolution.index);
				pendingSwitch = {
					from: account,
					hardStop:
						failureState.hardStop ??
						buildHardStop(undefined, { kind: "unknown", reason: "Authentication unavailable" }),
				};
				continue;
			}

			for (const pending of buffered) outer.push(pending);
			let finalError = terminalDecorated;
			if (classification.kind === "transient_rate_limit") {
				finalError = normalizeTransientRateLimitMessage(finalError, classification);
			}
			if (buffered.every((event) => event.type !== "start") && !committed) {
				outer.push({ type: "start", partial: finalError });
			}
			outer.push({
				type: "error",
				reason: finalError.stopReason === "aborted" ? "aborted" : "error",
				error: finalError,
			});
			return;
		}

		this.emitSyntheticError(outer, model, "error", this.unavailableMessage(resolutions, model.id));
	}

	private async resolveAccounts(signal?: AbortSignal): Promise<AccountResolution[]> {
		const registry = this.registry;
		if (!registry) return [];
		const raw = await Promise.all(
			this.config.accounts.map(async (slot, index): Promise<AccountResolution> => {
				if (!slot.enabled) return { index, slotId: slot.id, configured: false, error: "disabled" };
				if (signal?.aborted) return { index, slotId: slot.id, configured: false, error: "aborted" };
				const status = registry.getProviderAuthStatus(slot.authProviderId);
				if (!status.configured) {
					this.authErrors.delete(slot.id);
					this.authRejectedSlots.delete(slot.id);
					this.tokenFingerprints.delete(slot.id);
					return { index, slotId: slot.id, configured: false, error: "not logged in" };
				}
				try {
					const auth = await registry.getProviderAuth(slot.authProviderId);
					if (signal?.aborted) return { index, slotId: slot.id, configured: true, error: "aborted" };
					const apiKey = auth?.auth.apiKey;
					if (!auth || !apiKey) throw new Error("OAuth credential did not resolve to an access token");
					const identity = identifyAccount(apiKey);
					const tokenFingerprint = fingerprintSecret(apiKey);
					const previousTokenFingerprint = this.tokenFingerprints.get(slot.id);
					if (previousTokenFingerprint && previousTokenFingerprint !== tokenFingerprint) {
						this.authRejectedSlots.delete(slot.id);
						this.authErrors.delete(slot.id);
					}
					this.tokenFingerprints.set(slot.id, tokenFingerprint);
					const account: ResolvedAccount = {
						slot,
						index,
						auth,
						apiKey,
						identity,
						...(auth.env ? { env: auth.env } : {}),
					};
					if (!this.authRejectedSlots.has(slot.id)) this.authErrors.delete(slot.id);
					return { index, slotId: slot.id, configured: true, account };
				} catch (error) {
					const message = sanitizeErrorMessage(error);
					this.authErrors.set(slot.id, message);
					return { index, slotId: slot.id, configured: true, error: message };
				}
			}),
		);

		this.duplicateSlots.clear();
		const firstSlotByFingerprint = new Map<string, string>();
		const remembered: Array<{ slotId: string; fingerprint: string; observedAt: number }> = [];
		for (const resolution of raw) {
			const account = resolution.account;
			if (!account) continue;
			const first = firstSlotByFingerprint.get(account.identity.fingerprint);
			if (first) {
				account.duplicateOf = first;
				this.duplicateSlots.set(account.slot.id, first);
			} else {
				firstSlotByFingerprint.set(account.identity.fingerprint, account.slot.id);
			}
			this.knownFingerprints.set(account.slot.id, account.identity.fingerprint);
			remembered.push({
				slotId: account.slot.id,
				fingerprint: account.identity.fingerprint,
				observedAt: Date.now(),
			});
		}
		const snapshot = this.store.snapshot();
		const changed = remembered.filter((entry) => snapshot.slots[entry.slotId]?.fingerprint !== entry.fingerprint);
		if (changed.length > 0) {
			await this.store.rememberAccounts(changed).catch((error) => {
				this.warn(`Could not persist account identities: ${sanitizeErrorMessage(error)}`);
			});
		}
		return raw;
	}

	private async selectAccount(
		resolutions: AccountResolution[],
		tried: Set<number>,
		model: Model<"openai-codex-responses">,
		signal?: AbortSignal,
		requestEnv?: Record<string, string>,
	): Promise<SelectedAccount | undefined> {
		const snapshot = await this.store.refresh();
		let indices: number[];
		if (this.session.mode.type === "force") {
			const forcedAccountId = this.session.mode.accountId;
			const index = this.config.accounts.findIndex((account) => account.id === forcedAccountId);
			indices = index >= 0 ? [index] : [];
		} else {
			indices = Array.from({ length: this.config.accounts.length }, (_, offset) =>
				(this.session.cursor + offset) % this.config.accounts.length,
			);
		}
		for (const index of indices) {
			if (tried.has(index)) continue;
			const resolution = resolutions[index];
			const account = resolution?.account;
			if (
				!resolution ||
				!account ||
				account.duplicateOf ||
				this.authRejectedSlots.has(account.slot.id) ||
				signal?.aborted
			) continue;
			let state = this.effectiveState(account.identity.fingerprint, snapshot.accounts[account.identity.fingerprint]);
			let availability = accountAvailability(state, model.id, Date.now(), this.config.unknownResetRetryMs);
			if (availability.kind === "blocked") continue;
			if (availability.kind === "probe_needed") {
				const pollingAccount = this.withRequestEnv(account, requestEnv);
				const result = await this.pollAccount(pollingAccount, this.accountBaseUrl(account, model.baseUrl), {
					allowClear: true,
					recordHardStop: true,
					...(signal ? { signal } : {}),
				});
				if (result.ok) {
					const refreshed = this.store.snapshot();
					state = this.effectiveState(account.identity.fingerprint, refreshed.accounts[account.identity.fingerprint]);
					availability = accountAvailability(state, model.id, Date.now(), this.config.unknownResetRetryMs);
					if (availability.kind === "blocked") continue;
				}
			}
			this.session.cursor = index;
			this.session.activeAccountId = account.slot.id;
			this.session.activeFingerprint = account.identity.fingerprint;
			return { resolution, account };
		}
		return undefined;
	}

	private withRequestEnv(
		account: ResolvedAccount,
		override: Record<string, string> | undefined,
	): ResolvedAccount {
		const env = combineEnv(account.env, override);
		return env ? { ...account, env } : account;
	}

	private delegateOptions(
		account: ResolvedAccount,
		options: StreamOptions | SimpleStreamOptions | undefined,
		capture: AttemptCapture,
	): StreamOptions | SimpleStreamOptions {
		const upstreamFetch = options?.fetch ?? globalThis.fetch;
		const observedFetch = createObservedFetch(upstreamFetch, capture, (observation) => {
			this.runInBackground(this.observeHeaders(account, observation));
		});
		const headers = mergeHeaders(account.auth.auth.headers, options?.headers as ProviderHeaders | undefined);
		const env = combineEnv(account.env, options?.env);
		const {
			apiKey: _apiKey,
			fetch: _fetch,
			headers: _headers,
			env: _env,
			maxRetries: _maxRetries,
			...rest
		} = options ?? {};
		return {
			...rest,
			apiKey: account.apiKey,
			fetch: observedFetch,
			maxRetries: 0,
			...(headers ? { headers } : {}),
			...(env ? { env } : {}),
		};
	}

	private async observeHeaders(account: ResolvedAccount, observation: QuotaObservation): Promise<void> {
		await this.store
			.applyObservation(account.slot.id, account.identity.fingerprint, observation, {
				allowClear: false,
				recordHardStop: false,
			})
			.catch((error) => this.warn(`Could not persist Codex headers: ${sanitizeErrorMessage(error)}`));
		this.hooks.onStateChange?.();
	}

	private async pollAccount(
		account: ResolvedAccount,
		baseUrl: string,
		options: {
			allowClear: boolean;
			recordHardStop: boolean;
			signal?: AbortSignal;
		},
	): Promise<PollResult> {
		const fingerprint = account.identity.fingerprint;
		let operation = this.pollInFlight.get(fingerprint);
		if (!operation) {
			const signals = [this.sessionAbort.signal, options.signal].filter(
				(value): value is AbortSignal => value !== undefined,
			);
			const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
			operation = this.usageClient.poll(account, baseUrl, signal);
			this.pollInFlight.set(fingerprint, operation);
			const clearOperation = () => {
				if (this.pollInFlight.get(fingerprint) === operation) this.pollInFlight.delete(fingerprint);
			};
			void operation.then(clearOperation, clearOperation);
		}
		const result = await operation;
		if (!result.ok) return result;
		const observation = result.observation;
		if (options.recordHardStop && observationHasHardStop(observation)) {
			const stop = buildHardStop(observation, { kind: "endpoint_hard_stop" });
			this.runtimeStops.set(fingerprint, stop);
		} else if (options.allowClear && observationExplicitlyAllowsRequests(observation)) {
			const stop = this.runtimeStops.get(fingerprint);
			if (stop && observation.observedAt > stop.observedAt) this.runtimeStops.delete(fingerprint);
		}
		await this.store
			.applyObservation(account.slot.id, fingerprint, observation, {
				allowClear: options.allowClear,
				recordHardStop: options.recordHardStop,
			})
			.catch((error) => this.warn(`Could not persist Codex usage: ${sanitizeErrorMessage(error)}`));
		this.hooks.onStateChange?.();
		return result;
	}

	private async recordFailure(
		account: ResolvedAccount,
		model: Model<"openai-codex-responses">,
		classification: FailureClassification,
		capture: AttemptCapture,
		preliminaryPoll: QuotaObservation | undefined,
		awaitPoll: boolean,
		signal?: AbortSignal,
	): Promise<FailureStateResult> {
		if (classification.kind === "auth") {
			this.authRejectedSlots.add(account.slot.id);
			this.authErrors.set(account.slot.id, "OAuth credential was rejected; run /login again");
			return {};
		}
		let observation = preliminaryPoll ?? capture.lastHeaderObservation;
		if (classification.kind === "usage_limit" && !preliminaryPoll) {
			const poll = this.pollAccount(account, this.accountBaseUrl(account, model.baseUrl), {
				allowClear: false,
				recordHardStop: false,
				...(signal ? { signal } : {}),
			});
			if (awaitPoll) {
				const result = await poll;
				if (result.ok) observation = result.observation;
			} else {
				this.runInBackground(
					poll.then(async (result) => {
						if (!result.ok) return;
						const enriched = buildHardStop(result.observation, {
							kind: "usage_limit",
							observedAt: Date.now(),
							...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
							...(classification.limitId ? { limitId: classification.limitId } : {}),
						});
						if (
							enriched.resetAt === undefined &&
							enriched.exhaustedWindows.length === 0 &&
							!observationHasHardStop(result.observation)
						) return;
						await this.persistHardStop(account, enriched);
					}),
				);
			}
		}
		if (classification.kind === "usage_not_included") {
			const hardStop = buildHardStop(observation, {
				kind: "usage_not_included",
				modelId: model.id,
				reason: "Selected model is not included for this account",
			});
			this.setRuntimeHardStop(account.identity.fingerprint, hardStop);
			await this.persistHardStop(account, hardStop);
			return { hardStop, ...(observation ? { pollObservation: observation } : {}) };
		}
		if (classification.kind !== "usage_limit") return {};
		const hardStop = buildHardStop(observation, {
			kind: "usage_limit",
			observedAt: capture.httpError?.observedAt ?? Date.now(),
			...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
			...(classification.limitId ? { limitId: classification.limitId } : {}),
			reason: sanitizeErrorMessage(
				classification.reachedType ?? capture.httpError?.message ?? "Codex usage window exhausted",
			),
		});
		this.setRuntimeHardStop(account.identity.fingerprint, hardStop);
		await this.persistHardStop(account, hardStop);
		return { hardStop, ...(observation ? { pollObservation: observation } : {}) };
	}

	private setRuntimeHardStop(fingerprint: string, hardStop: HardStop): void {
		if (hardStop.modelId) {
			let blocks = this.runtimeModelStops.get(fingerprint);
			if (!blocks) {
				blocks = new Map();
				this.runtimeModelStops.set(fingerprint, blocks);
			}
			blocks.set(hardStop.modelId, hardStop);
		} else {
			this.runtimeStops.set(fingerprint, hardStop);
		}
	}

	private async persistHardStop(account: ResolvedAccount, hardStop: HardStop): Promise<void> {
		await this.store
			.setHardStop(account.slot.id, account.identity.fingerprint, hardStop)
			.catch((error) => this.warn(`Could not persist Codex cooldown: ${sanitizeErrorMessage(error)}`));
		this.hooks.onStateChange?.();
	}

	private recordSuccess(account: ResolvedAccount, index: number, baseUrl: string): void {
		this.session.cursor = index;
		this.session.activeAccountId = account.slot.id;
		this.session.activeFingerprint = account.identity.fingerprint;
		this.authErrors.delete(account.slot.id);
		this.authRejectedSlots.delete(account.slot.id);
		this.runInBackground(
			this.store
				.markSuccess(account.slot.id, account.identity.fingerprint)
				.catch((error) => this.warn(`Could not persist Codex success state: ${sanitizeErrorMessage(error)}`)),
		);
		const state = this.store.snapshot().accounts[account.identity.fingerprint];
		if (!state?.lastPollAt || Date.now() - state.lastPollAt >= this.config.usagePollTtlMs) {
			this.runInBackground(
				this.pollAccount(account, this.accountBaseUrl(account, baseUrl), {
					allowClear: true,
					recordHardStop: true,
				}).catch((error) => this.warn(`Codex usage refresh failed: ${sanitizeErrorMessage(error)}`)),
			);
		}
		this.hooks.onStateChange?.();
	}

	private effectiveState(
		fingerprint: string,
		persisted: PersistedAccountState | undefined,
	): PersistedAccountState {
		const state = structuredClone(persisted ?? emptyAccountState(fingerprint));
		const runtime = this.runtimeStops.get(fingerprint);
		if (runtime && (!state.hardStop || runtime.observedAt >= state.hardStop.observedAt)) state.hardStop = runtime;
		for (const [modelId, hardStop] of this.runtimeModelStops.get(fingerprint) ?? []) {
			const current = state.modelBlocks[modelId];
			if (!current || hardStop.observedAt >= current.observedAt) state.modelBlocks[modelId] = hardStop;
		}
		return state;
	}

	private accountBaseUrl(account: ResolvedAccount, modelBaseUrl?: string): string {
		return account.auth.auth.baseUrl ?? modelBaseUrl ?? this.baseProvider.baseUrl ?? "https://chatgpt.com/backend-api";
	}

	private unavailableMessage(resolutions: AccountResolution[], modelId: string): string {
		const snapshot = this.store.snapshot();
		const parts: string[] = [];
		for (const [index, slot] of this.config.accounts.entries()) {
			if (!slot.enabled) {
				parts.push(`${slot.label}: disabled`);
				continue;
			}
			const resolution = resolutions[index];
			const authError = this.authErrors.get(slot.id);
			if (authError) {
				parts.push(`${slot.label}: authentication rejected; run /login ${slot.authProviderId}`);
				continue;
			}
			if (!resolution?.account) {
				parts.push(`${slot.label}: ${resolution?.error ?? "not logged in"}`);
				continue;
			}
			if (resolution.account.duplicateOf) {
				parts.push(`${slot.label}: duplicates ${resolution.account.duplicateOf}`);
				continue;
			}
			const fingerprint = resolution.account.identity.fingerprint;
			const state = this.effectiveState(fingerprint, snapshot.accounts[fingerprint]);
			const availability = accountAvailability(state, modelId, Date.now(), this.config.unknownResetRetryMs);
			parts.push(
				availability.kind === "eligible"
					? `${slot.label}: unavailable for this attempt`
					: `${slot.label}: ${hardStopSummary(availability.hardStop)}`,
			);
		}
		const prefix = this.session.mode.type === "force" ? "The forced Codex account is unavailable" : "All Codex ring accounts are unavailable";
		return `${prefix}. ${parts.join("; ").slice(0, 1600)}. Run /codex-ring status --refresh.`;
	}

	private emitSyntheticError(
		outer: AssistantMessageEventStream,
		model: Model<"openai-codex-responses">,
		reason: "error" | "aborted",
		message: string,
	): void {
		const error = syntheticMessage(model, reason, message);
		outer.push({ type: "start", partial: error });
		outer.push({ type: "error", reason, error });
	}

	private runInBackground(operation: Promise<unknown>): void {
		let tracked: Promise<void>;
		tracked = operation.then(
			() => undefined,
			(error) => this.warn(`Background operation failed: ${sanitizeErrorMessage(error)}`),
		);
		this.backgroundTasks.add(tracked);
		void tracked.then(() => this.backgroundTasks.delete(tracked));
	}

	private warn(message: string): void {
		try {
			this.hooks.onWarning?.(message);
		} catch {
			// Reporting a warning must never fail routing or shutdown.
		}
	}
}
