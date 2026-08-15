import { join } from "node:path";
import {
	getAgentDir,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	clearFooter,
	formatSwitchMessage,
	registerCommands,
	updateFooter,
} from "./commands.ts";
import { loadConfig, STATE_FILE_NAME } from "./config.ts";
import { registerRingProviders } from "./providers.ts";
import { RingRouter } from "./router.ts";
import { StateStore } from "./state.ts";

const MINIMUM_PI_VERSION = "0.84.2";

function compareVersions(left: string, right: string): number {
	const parse = (value: string): number[] => value.split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export default async function codexRingExtension(pi: ExtensionAPI): Promise<void> {
	if (compareVersions(VERSION, MINIMUM_PI_VERSION) < 0) {
		throw new Error(`pi-codex-ring requires Pi ${MINIMUM_PI_VERSION} or newer (found ${VERSION})`);
	}
	const agentDir = getAgentDir();
	const loaded = await loadConfig(agentDir);
	const store = new StateStore(join(agentDir, STATE_FILE_NAME));
	await store.initialize();
	let currentContext: ExtensionContext | undefined;

	const router = new RingRouter(loaded.config, store, {
		onSwitch(from, to, hardStop) {
			const message = formatSwitchMessage(from.slot.label, to.slot.label, hardStop);
			if (currentContext?.hasUI) currentContext.ui.notify(message, "warning");
			else console.error(`[codex-ring] ${message}`);
			updateFooter(currentContext, router, loaded.config);
		},
		onStateChange() {
			updateFooter(currentContext, router, loaded.config);
		},
		onWarning(message) {
			if (currentContext?.hasUI) currentContext.ui.notify(message, "warning");
			else console.error(`[codex-ring] ${message}`);
		},
	});

	registerRingProviders(pi, loaded.config, router);
	registerCommands(pi, router, loaded.config);

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		router.bindRegistry(ctx.modelRegistry);
		router.startSession();
		for (const warning of loaded.warnings) {
			if (ctx.hasUI) ctx.ui.notify(`${warning}\nConfig: ${loaded.path}`, "warning");
			else console.error(`[codex-ring] ${warning} Config: ${loaded.path}`);
		}
		for (const warning of store.warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else console.error(`[codex-ring] ${warning}`);
		}
		updateFooter(ctx, router, loaded.config);
	});

	pi.on("model_select", (_event, ctx) => {
		currentContext = ctx;
		updateFooter(ctx, router, loaded.config);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearFooter(ctx);
		await router.shutdown();
		currentContext = undefined;
	});
}
