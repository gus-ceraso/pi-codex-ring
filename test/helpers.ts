import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
} from "@earendil-works/pi-ai";

export function jwt(accountId: string, userId = `user-${accountId}`, extra: Record<string, unknown> = {}): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({
		sub: userId,
		"https://api.openai.com/auth": {
			chatgpt_account_id: accountId,
			chatgpt_user_id: userId,
			chatgpt_plan_type: "plus",
			...extra,
		},
	})}.signature`;
}

export const testModel: Model<"openai-codex-responses"> = {
	id: "gpt-test-codex",
	name: "Test Codex",
	api: "openai-codex-responses",
	provider: "openai-codex-ring",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

export function assistant(
	model: Model<"openai-codex-responses">,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
		...overrides,
	};
}

export function eventStream(events: AssistantMessageEvent[]) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) stream.push(event);
		stream.end();
	});
	return stream;
}
