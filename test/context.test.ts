import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { identifyAccount } from "../src/account.js";
import { adaptContext, decorateAssistantMessage } from "../src/context.js";
import { RING_DIAGNOSTIC_TYPE, type ResolvedAccount, type RingAccountConfig } from "../src/types.js";
import { assistant, jwt, testModel } from "./helpers.js";

function account(id: string, slotId: string): ResolvedAccount {
	const apiKey = jwt(id);
	const slot: RingAccountConfig = {
		id: slotId,
		label: slotId,
		enabled: true,
		useBuiltinProvider: slotId === "a",
		authProviderId: slotId === "a" ? "openai-codex" : `openai-codex-ring-auth-${slotId}`,
	};
	return {
		slot,
		index: slotId === "a" ? 0 : 1,
		auth: { auth: { apiKey }, source: "test" },
		apiKey,
		identity: identifyAccount(apiKey),
	};
}

function sourceMessage(source: ResolvedAccount): AssistantMessage {
	return assistant(testModel, {
		provider: "openai-codex-ring",
		stopReason: "stop",
		responseId: "resp_account_bound",
		content: [
			{ type: "thinking", thinking: "secret reasoning", thinkingSignature: '{"id":"rs_123","encrypted_content":"opaque"}' },
			{ type: "text", text: "answer", textSignature: '{"v":1,"id":"msg_123"}' },
			{
				type: "toolCall",
				id: "call_1|fc_account_bound",
				name: "read",
				arguments: { path: "README.md" },
				thoughtSignature: "opaque",
			},
		],
		diagnostics: [
			{
				type: RING_DIAGNOSTIC_TYPE,
				timestamp: 1,
				details: { accountFingerprint: source.identity.fingerprint, accountSlotId: source.slot.id },
			},
		],
	});
}

describe("cross-account context", () => {
	it("retains native continuation metadata for the same account", () => {
		const a = account("account-a", "a");
		const source = sourceMessage(a);
		const adapted = adaptContext({ messages: [source] }, a, "openai-codex-ring");
		const message = adapted.messages[0] as AssistantMessage;
		expect(message.provider).toBe("openai-codex");
		expect(message.responseId).toBe("resp_account_bound");
		expect(message.content[0]).toHaveProperty("thinkingSignature");
	});

	it("drops account-bound IDs and encrypted reasoning for another account", () => {
		const a = account("account-a", "a");
		const b = account("account-b", "b");
		const source = sourceMessage(a);
		const context: Context = {
			messages: [
				source,
				{
					role: "toolResult",
					toolCallId: "call_1|fc_account_bound",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const adapted = adaptContext(context, b, "openai-codex-ring");
		const message = adapted.messages[0] as AssistantMessage;
		expect(message.provider).toBe("openai-codex-ring");
		expect(message.responseId).toBeUndefined();
		expect(message.content.some((block) => block.type === "thinking")).toBe(false);
		expect(message.content.find((block) => block.type === "text")).not.toHaveProperty("textSignature");
		expect(message.content.find((block) => block.type === "toolCall")).not.toHaveProperty("thoughtSignature");
		// The original session object is never mutated.
		expect(source.responseId).toBe("resp_account_bound");
		expect(source.content[0]).toHaveProperty("thinkingSignature");
	});

	it("uses the safe foreign path for untagged pre-extension history", () => {
		const b = account("account-b", "b");
		const untagged = sourceMessage(account("account-a", "a"));
		delete untagged.diagnostics;
		const adapted = adaptContext({ messages: [untagged] }, b, "openai-codex-ring");
		const message = adapted.messages[0] as AssistantMessage;
		expect(message.provider).toBe("openai-codex-ring");
		expect(message.responseId).toBeUndefined();
		expect(message.content.some((block) => block.type === "thinking")).toBe(false);
	});

	it("tags successful output with only a hashed account identity", () => {
		const a = account("account-a", "a");
		const decorated = decorateAssistantMessage(sourceMessage(a), a, "openai-codex-ring", 2, 123);
		const diagnostic = decorated.diagnostics?.find((entry) => entry.type === RING_DIAGNOSTIC_TYPE);
		expect(decorated.provider).toBe("openai-codex-ring");
		expect(diagnostic?.details).toMatchObject({
			accountFingerprint: a.identity.fingerprint,
			accountSlotId: "a",
			attempt: 2,
		});
		expect(JSON.stringify(diagnostic)).not.toContain("account-a");
		expect(JSON.stringify(diagnostic)).not.toContain(a.apiKey);
	});

	it("redacts credential-like data from decorated provider errors", () => {
		const a = account("account-a", "a");
		const decorated = decorateAssistantMessage(
			assistant(testModel, {
				errorMessage: "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0.sig",
			}),
			a,
			"openai-codex-ring",
			1,
			1,
		);
		expect(decorated.errorMessage).toContain("[redacted]");
		expect(decorated.errorMessage).not.toContain("eyJhbGci");
	});
});
