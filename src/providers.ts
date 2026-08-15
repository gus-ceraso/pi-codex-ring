import {
	createProvider,
	type Context,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBuiltinCodexProvider } from "./codex-provider.ts";
import type { RingConfig } from "./types.ts";

export interface RingStreams {
	stream(model: Model<"openai-codex-responses">, context: Context, options?: StreamOptions): ReturnType<ProviderStreams["stream"]>;
	streamSimple(
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: SimpleStreamOptions,
	): ReturnType<ProviderStreams["streamSimple"]>;
}

export function registerRingProviders(pi: ExtensionAPI, config: RingConfig, ringStreams: RingStreams): void {
	const template = createBuiltinCodexProvider();
	const templateStreams: ProviderStreams = {
		stream: (model, context, options) =>
			template.stream(model as Model<"openai-codex-responses">, context, options),
		streamSimple: (model, context, options) =>
			template.streamSimple(model as Model<"openai-codex-responses">, context, options),
	};

	for (const account of config.accounts) {
		if (account.useBuiltinProvider) continue;
		pi.registerProvider(
			createProvider<"openai-codex-responses">({
				id: account.authProviderId,
				name: `OpenAI Codex — ${account.label}`,
				...(template.baseUrl ? { baseUrl: template.baseUrl } : {}),
				auth: template.auth,
				models: [],
				api: templateStreams,
			}),
		);
	}

	const models = template.getModels().map((model) => ({
		...model,
		provider: config.providerId,
	}));

	pi.registerProvider(
		createProvider<"openai-codex-responses">({
			id: config.providerId,
			name: "OpenAI Codex Account Ring",
			...(template.baseUrl ? { baseUrl: template.baseUrl } : {}),
			auth: {
				apiKey: {
					name: "Codex account ring",
					async check() {
						return { type: "api_key", source: "configured account ring" };
					},
					async resolve() {
						return { auth: { apiKey: "pi-codex-ring" }, source: "configured account ring" };
					},
				},
			},
			models,
			api: {
				stream: (model, context, options) =>
					ringStreams.stream(model as Model<"openai-codex-responses">, context, options),
				streamSimple: (model, context, options) =>
					ringStreams.streamSimple(model as Model<"openai-codex-responses">, context, options),
			},
		}),
	);
}
