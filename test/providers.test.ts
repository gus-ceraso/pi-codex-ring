import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { registerRingProviders } from "../src/providers.js";

describe("provider registration", () => {
	it("registers auth-only aliases and leaves a complete native pool provider last", () => {
		const calls: unknown[][] = [];
		const pi = {
			registerProvider(...args: unknown[]) {
				calls.push(args);
			},
		} as unknown as ExtensionAPI;
		const config = parseConfig({
			version: 1,
			accounts: [
				{ id: "primary", label: "Primary", useBuiltinProvider: true },
				{ id: "backup", label: "Backup" },
			],
		});
		const streams = {
			stream: (() => {
				throw new Error("unused");
			}) as never,
			streamSimple: (() => {
				throw new Error("unused");
			}) as never,
		};
		registerRingProviders(pi, config, streams);

		const alias = calls[0]?.[0] as { id: string; getModels(): unknown[] };
		expect(alias.id).toBe("openai-codex-ring-auth-backup");
		expect(alias.getModels()).toEqual([]);
		const pool = calls[1]?.[0] as { id: string; getModels(): unknown[]; stream: unknown; streamSimple: unknown };
		expect(pool.id).toBe("openai-codex-ring");
		expect(pool.getModels().length).toBeGreaterThan(0);
		expect(pool.stream).toBeTypeOf("function");
		expect(pool.streamSimple).toBeTypeOf("function");
	});
});
