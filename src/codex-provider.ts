import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

let cached: Provider<"openai-codex-responses"> | undefined;

export function createBuiltinCodexProvider(): Provider<"openai-codex-responses"> {
	if (cached) return cached;
	const provider = builtinProviders().find((entry) => entry.id === "openai-codex");
	if (!provider) throw new Error("Pi's built-in openai-codex provider is unavailable");
	cached = provider as Provider<"openai-codex-responses">;
	return cached;
}
