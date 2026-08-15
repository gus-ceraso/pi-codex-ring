import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	AUTH_PROVIDER_PREFIX,
	BUILTIN_CODEX_PROVIDER_ID,
	CONFIG_VERSION,
	DEFAULT_POOL_PROVIDER_ID,
	type LoadedRingConfig,
	type RingAccountConfig,
	type RingConfig,
} from "./types.ts";

export const CONFIG_FILE_NAME = "codex-ring.json";
export const STATE_FILE_NAME = "codex-ring-state.json";
const MAX_CONFIG_BYTES = 1024 * 1024;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

interface RawConfig {
	version?: unknown;
	providerId?: unknown;
	accounts?: unknown;
	usagePollTtlSeconds?: unknown;
	usagePollTimeoutSeconds?: unknown;
	unknownResetRetrySeconds?: unknown;
	statusStaleSeconds?: unknown;
}

interface RawAccount {
	id?: unknown;
	label?: unknown;
	enabled?: unknown;
	useBuiltinProvider?: unknown;
}

export function defaultConfig(): RingConfig {
	return {
		version: CONFIG_VERSION,
		providerId: DEFAULT_POOL_PROVIDER_ID,
		accounts: [
			{
				id: "primary",
				label: "Primary",
				enabled: true,
				useBuiltinProvider: true,
				authProviderId: BUILTIN_CODEX_PROVIDER_ID,
			},
		],
		usagePollTtlMs: 60_000,
		usagePollTimeoutMs: 10_000,
		unknownResetRetryMs: 300_000,
		statusStaleMs: 15 * 60_000,
	};
}

function asObject(value: unknown, description: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${description} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function boundedSeconds(
	value: unknown,
	name: string,
	defaultSeconds: number,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined) return defaultSeconds * 1000;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be a finite number from ${minimum} to ${maximum}`);
	}
	return Math.round(value * 1000);
}

function parseAccount(value: unknown, index: number, poolProviderId: string): RingAccountConfig {
	const raw = asObject(value, `accounts[${index}]`) as RawAccount;
	if (typeof raw.id !== "string" || raw.id.length > 64 || !ACCOUNT_ID_PATTERN.test(raw.id)) {
		throw new Error(`accounts[${index}].id must match ${ACCOUNT_ID_PATTERN} and be at most 64 characters`);
	}
	if (
		typeof raw.label !== "string" ||
		raw.label.trim().length === 0 ||
		raw.label.length > 80 ||
		/[\u0000-\u001f\u007f]/.test(raw.label)
	) {
		throw new Error(`accounts[${index}].label must be a non-empty control-free string of at most 80 characters`);
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		throw new Error(`accounts[${index}].enabled must be a boolean`);
	}
	if (raw.useBuiltinProvider !== undefined && typeof raw.useBuiltinProvider !== "boolean") {
		throw new Error(`accounts[${index}].useBuiltinProvider must be a boolean`);
	}
	const useBuiltinProvider = raw.useBuiltinProvider === true;
	const authProviderId = useBuiltinProvider ? BUILTIN_CODEX_PROVIDER_ID : `${AUTH_PROVIDER_PREFIX}${raw.id}`;
	if (authProviderId === poolProviderId) {
		throw new Error(`accounts[${index}] auth provider collides with pool provider ${poolProviderId}`);
	}
	return {
		id: raw.id,
		label: raw.label.trim(),
		enabled: raw.enabled !== false,
		useBuiltinProvider,
		authProviderId,
	};
}

export function parseConfig(value: unknown): RingConfig {
	const raw = asObject(value, "config") as RawConfig;
	if (raw.version !== CONFIG_VERSION) {
		throw new Error(`config.version must be ${CONFIG_VERSION}`);
	}
	const providerId = raw.providerId === undefined ? DEFAULT_POOL_PROVIDER_ID : raw.providerId;
	if (
		typeof providerId !== "string" ||
		providerId.length > 128 ||
		!PROVIDER_ID_PATTERN.test(providerId) ||
		providerId === BUILTIN_CODEX_PROVIDER_ID
	) {
		throw new Error(`providerId must be a valid provider ID other than ${BUILTIN_CODEX_PROVIDER_ID}`);
	}
	if (!Array.isArray(raw.accounts) || raw.accounts.length === 0 || raw.accounts.length > 32) {
		throw new Error("accounts must contain between 1 and 32 entries");
	}
	const accounts = raw.accounts.map((entry, index) => parseAccount(entry, index, providerId));
	const accountIds = new Set<string>();
	const providerIds = new Set<string>([providerId]);
	let builtinCount = 0;
	for (const account of accounts) {
		if (accountIds.has(account.id)) throw new Error(`duplicate account id: ${account.id}`);
		if (providerIds.has(account.authProviderId)) {
			throw new Error(`duplicate or colliding provider id: ${account.authProviderId}`);
		}
		accountIds.add(account.id);
		providerIds.add(account.authProviderId);
		if (account.useBuiltinProvider) builtinCount++;
	}
	if (builtinCount > 1) throw new Error("at most one account may set useBuiltinProvider=true");

	return {
		version: CONFIG_VERSION,
		providerId,
		accounts,
		usagePollTtlMs: boundedSeconds(raw.usagePollTtlSeconds, "usagePollTtlSeconds", 60, 10, 3600),
		usagePollTimeoutMs: boundedSeconds(raw.usagePollTimeoutSeconds, "usagePollTimeoutSeconds", 10, 1, 60),
		unknownResetRetryMs: boundedSeconds(
			raw.unknownResetRetrySeconds,
			"unknownResetRetrySeconds",
			300,
			30,
			86_400,
		),
		statusStaleMs: boundedSeconds(raw.statusStaleSeconds, "statusStaleSeconds", 900, 60, 86_400),
	};
}

export async function loadConfig(agentDir: string): Promise<LoadedRingConfig> {
	const path = join(agentDir, CONFIG_FILE_NAME);
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`${path} is not a regular file`);
		if (info.size > MAX_CONFIG_BYTES) throw new Error(`${path} exceeds ${MAX_CONFIG_BYTES} bytes`);
		const text = await readFile(path, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const warnings: string[] = [];
		try {
			await chmod(path, 0o600);
		} catch (error) {
			warnings.push(`Could not restrict ${path} to mode 0600: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { config: parseConfig(parsed), path, exists: true, warnings };
	} catch (error) {
		if (isMissingFileError(error)) {
			return {
				config: defaultConfig(),
				path,
				exists: false,
				warnings: [`No ${CONFIG_FILE_NAME} found; using one built-in Primary account.`],
			};
		}
		throw error;
	}
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
