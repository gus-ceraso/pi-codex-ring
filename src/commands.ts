import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sanitizeErrorMessage } from "./account.ts";
import { findWindow } from "./quota.ts";
import type { RingRouter } from "./router.ts";
import type { HardStop, RingConfig, StatusRow, UsageWindowSnapshot } from "./types.ts";

const STATUS_KEY = "codex-ring";

function formatReset(resetAt: number | undefined): string {
	if (resetAt === undefined) return "reset unknown";
	const delta = resetAt - Date.now();
	if (delta <= 0) return "ready to probe";
	const minutes = Math.ceil(delta / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 48) return `resets in ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return `resets in ${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

function formatWindow(window: UsageWindowSnapshot | undefined, stale: boolean): string {
	if (!window) return "—";
	const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
	const value = Number.isInteger(remaining) ? remaining.toFixed(0) : remaining.toFixed(1);
	return `${stale ? "~" : ""}${value}% left, ${formatReset(window.resetAt)}`;
}

function hardStopLabel(stop: HardStop): string {
	switch (stop.kind) {
		case "usage_limit":
		case "endpoint_hard_stop":
			return `usage cooldown (${formatReset(stop.resetAt)})`;
		case "usage_not_included":
			return "model not included";
		case "credits_depleted":
			return "workspace credits depleted";
		case "spend_cap":
			return "workspace spend cap reached";
		case "unknown":
			return stop.reason ?? `unavailable (${formatReset(stop.resetAt)})`;
	}
}

function rowState(row: StatusRow): string {
	if (!row.enabled) return "disabled";
	if (!row.authConfigured) return `not logged in — /login ${row.authProviderId}`;
	if (row.authError) return `auth error — ${row.authError}`;
	if (row.duplicateOf) return `duplicate of ${row.duplicateOf}`;
	if (row.state?.hardStop) return hardStopLabel(row.state.hardStop);
	const blockedModels = Object.keys(row.state?.modelBlocks ?? {});
	if (blockedModels.length > 0) return `model unavailable: ${blockedModels.join(", ")}`;
	return "available";
}

export function formatStatus(router: RingRouter, config: RingConfig): string {
	const rows = router.statusRows();
	const mode = router.mode.type === "auto" ? "automatic" : `forced: ${router.mode.accountId}`;
	const lines = [`Codex account ring (${mode})`];
	for (const row of rows) {
		const marker = row.active ? "▶" : " ";
		const forced = row.forced ? " [forced]" : "";
		const observedAt = row.state?.lastObservedAt;
		const stale = observedAt === undefined || Date.now() - observedAt > config.statusStaleMs;
		const fiveHour = row.state ? findWindow(row.state.limits, "five_hour") : undefined;
		const weekly = row.state ? findWindow(row.state.limits, "weekly") : undefined;
		lines.push(`${marker} ${row.label} (${row.id})${forced}`);
		lines.push(`    ${rowState(row)}`);
		lines.push(`    5h: ${formatWindow(fiveHour, stale)}`);
		lines.push(`    7d: ${formatWindow(weekly, stale)}`);
		if (row.state?.planType) lines.push(`    plan: ${row.state.planType}`);
	}
	return lines.join("\n");
}

export function updateFooter(ctx: ExtensionContext | undefined, router: RingRouter, config: RingConfig): void {
	if (!ctx?.hasUI) return;
	if (ctx.model?.provider !== config.providerId) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const rows = router.statusRows();
	const active = rows.find((row) => row.active);
	if (!active) {
		const configured = rows.filter((row) => row.enabled && row.authConfigured && !row.duplicateOf).length;
		ctx.ui.setStatus(STATUS_KEY, `Codex ring · ${configured} account${configured === 1 ? "" : "s"}`);
		return;
	}
	const observedAt = active.state?.lastObservedAt;
	const stale = observedAt === undefined || Date.now() - observedAt > config.statusStaleMs;
	const fiveHour = active.state ? findWindow(active.state.limits, "five_hour") : undefined;
	const weekly = active.state ? findWindow(active.state.limits, "weekly") : undefined;
	const compactWindow = (window: UsageWindowSnapshot | undefined): string => {
		if (!window) return "—";
		const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
		return `${stale ? "~" : ""}${Math.round(remaining)}% left`;
	};
	ctx.ui.setStatus(
		STATUS_KEY,
		`Codex ${active.label} · 5h ${compactWindow(fiveHour)} · 7d ${compactWindow(weekly)}`,
	);
}

export function clearFooter(ctx: ExtensionContext | undefined): void {
	if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

function show(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.error(`[codex-ring] ${message}`);
}

async function handleCommand(
	args: string,
	ctx: ExtensionCommandContext,
	router: RingRouter,
	config: RingConfig,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const command = tokens[0] ?? "status";
	if (command === "status") {
		const unknown = tokens.slice(1).filter((token) => token !== "--refresh");
		if (unknown.length > 0) {
			show(ctx, `Unknown status option: ${unknown.join(" ")}`, "error");
			return;
		}
		if (tokens.includes("--refresh")) {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "Codex ring · refreshing usage…");
			try {
				await router.refreshAll();
			} catch (error) {
				show(ctx, `Usage refresh failed: ${sanitizeErrorMessage(error)}`, "warning");
			}
		}
		show(ctx, formatStatus(router, config));
		updateFooter(ctx, router, config);
		return;
	}
	if (command === "next") {
		await ctx.waitForIdle();
		const next = router.next();
		show(ctx, next ? `Next Codex request will start at ${next}.` : "No enabled Codex accounts.", next ? "info" : "warning");
		updateFooter(ctx, router, config);
		return;
	}
	if (command === "mode") {
		await ctx.waitForIdle();
		if (tokens[1] === "auto" && tokens.length === 2) {
			router.setAutoMode();
			show(ctx, "Codex ring is now in automatic failover mode.");
			updateFooter(ctx, router, config);
			return;
		}
		if (tokens[1] === "force" && tokens[2] && tokens.length === 3) {
			if (!router.forceAccount(tokens[2])) {
				show(ctx, `Unknown or disabled account: ${tokens[2]}`, "error");
				return;
			}
			show(ctx, `Codex ring is forced to ${tokens[2]}; automatic failover is disabled.`, "warning");
			updateFooter(ctx, router, config);
			return;
		}
		show(ctx, "Usage: /codex-ring mode auto | /codex-ring mode force <account-id>", "error");
		return;
	}
	if (command === "clear") {
		await ctx.waitForIdle();
		if (!tokens[1] || tokens.length !== 2) {
			show(ctx, "Usage: /codex-ring clear <account-id>", "error");
			return;
		}
		const cleared = await router.clear(tokens[1]);
		show(
			ctx,
			cleared
				? `Cleared local cooldown state for ${tokens[1]}; this does not reset OpenAI usage.`
				: `Unknown account: ${tokens[1]}`,
			cleared ? "warning" : "error",
		);
		updateFooter(ctx, router, config);
		return;
	}
	show(
		ctx,
		"Usage: /codex-ring status [--refresh] | next | mode auto | mode force <account-id> | clear <account-id>",
		"error",
	);
}

export function registerCommands(pi: ExtensionAPI, router: RingRouter, config: RingConfig): void {
	pi.registerCommand("codex-ring", {
		description: "Inspect and control the Codex OAuth account failover ring",
		getArgumentCompletions: (prefix) => {
			const options = [
				"status",
				"status --refresh",
				"next",
				"mode auto",
				...config.accounts.map((account) => `mode force ${account.id}`),
				...config.accounts.map((account) => `clear ${account.id}`),
			];
			const matches = options
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: (args, ctx) => handleCommand(args, ctx, router, config),
	});
}

export function formatSwitchMessage(from: string, to: string, hardStop: HardStop): string {
	return `Codex ${from} became unavailable (${hardStopLabel(hardStop)}); switched to ${to}.`;
}
