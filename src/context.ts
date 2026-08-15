import type {
	AssistantMessage,
	AssistantMessageDiagnostic,
	AssistantMessageEvent,
	Context,
	Message,
	ToolCall,
} from "@earendil-works/pi-ai";
import { sanitizeErrorMessage } from "./account.ts";
import {
	BUILTIN_CODEX_PROVIDER_ID,
	RING_DIAGNOSTIC_TYPE,
	type ResolvedAccount,
} from "./types.ts";

function accountFingerprint(message: AssistantMessage): string | undefined {
	for (let index = (message.diagnostics?.length ?? 0) - 1; index >= 0; index--) {
		const diagnostic = message.diagnostics?.[index];
		if (diagnostic?.type !== RING_DIAGNOSTIC_TYPE) continue;
		const value = diagnostic.details?.accountFingerprint;
		if (typeof value === "string") return value;
	}
	return undefined;
}

function cloneToolCall(block: ToolCall): ToolCall {
	return {
		...block,
		arguments: structuredClone(block.arguments),
	};
}

export function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block) => {
			if (block.type === "toolCall") return cloneToolCall(block);
			return { ...block };
		}),
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
		...(message.diagnostics ? { diagnostics: structuredClone(message.diagnostics) } : {}),
		...(message.deferred ? { deferred: structuredClone(message.deferred) } : {}),
	};
}

function adaptAssistantMessage(
	message: AssistantMessage,
	account: ResolvedAccount,
	poolProviderId: string,
): AssistantMessage {
	const sameAccount = accountFingerprint(message) === account.identity.fingerprint;
	if (sameAccount) {
		return {
			...cloneAssistantMessage(message),
			provider: BUILTIN_CODEX_PROVIDER_ID,
		};
	}

	const clone = cloneAssistantMessage(message);
	const { responseId: _responseId, deferred: _deferred, ...withoutContinuation } = clone;
	const content = clone.content.reduce<AssistantMessage["content"]>((result, block) => {
		// Encrypted reasoning and reasoning item IDs are account-bound. Omitting
		// foreign thinking is safer than replaying or exposing it as plain text.
		if (block.type === "thinking") return result;
		if (block.type === "text") {
			const { textSignature: _textSignature, ...text } = block;
			result.push(text);
			return result;
		}
		const { thoughtSignature: _thoughtSignature, ...toolCall } = block;
		result.push({ ...toolCall, arguments: structuredClone(toolCall.arguments) });
		return result;
	}, []);
	return {
		...withoutContinuation,
		provider: poolProviderId,
		content,
	};
}

function cloneMessage(message: Message, account: ResolvedAccount, poolProviderId: string): Message {
	if (message.role === "assistant") return adaptAssistantMessage(message, account, poolProviderId);
	if (message.role === "user") {
		return {
			...message,
			content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
		};
	}
	return {
		...message,
		content: message.content.map((block) => ({ ...block })),
		...(message.usage ? { usage: { ...message.usage, cost: { ...message.usage.cost } } } : {}),
		...(message.addedToolNames ? { addedToolNames: [...message.addedToolNames] } : {}),
	};
}

export function adaptContext(context: Context, account: ResolvedAccount, poolProviderId: string): Context {
	return {
		...context,
		messages: context.messages.map((message) => cloneMessage(message, account, poolProviderId)),
		...(context.tools ? { tools: context.tools.map((tool) => ({ ...tool })) } : {}),
	};
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return sanitizeErrorMessage(value);
	if (depth >= 6 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, sanitizeDiagnosticValue(entry, depth + 1)]),
	);
}

function sanitizeDiagnostic(diagnostic: AssistantMessageDiagnostic): AssistantMessageDiagnostic {
	return sanitizeDiagnosticValue(diagnostic) as AssistantMessageDiagnostic;
}

function ringDiagnostic(account: ResolvedAccount, attempt: number, timestamp: number): AssistantMessageDiagnostic {
	return {
		type: RING_DIAGNOSTIC_TYPE,
		timestamp,
		details: {
			accountFingerprint: account.identity.fingerprint,
			accountSlotId: account.slot.id,
			attempt,
		},
	};
}

export function decorateAssistantMessage(
	message: AssistantMessage,
	account: ResolvedAccount,
	poolProviderId: string,
	attempt: number,
	timestamp: number,
): AssistantMessage {
	const clone = cloneAssistantMessage(message);
	const diagnostics = (clone.diagnostics ?? [])
		.filter((entry) => entry.type !== RING_DIAGNOSTIC_TYPE)
		.map(sanitizeDiagnostic);
	diagnostics.push(ringDiagnostic(account, attempt, timestamp));
	return {
		...clone,
		provider: poolProviderId,
		...(clone.errorMessage ? { errorMessage: sanitizeErrorMessage(clone.errorMessage) } : {}),
		diagnostics,
		...(clone.deferred ? { deferred: { ...clone.deferred, provider: poolProviderId } } : {}),
	};
}

export function decorateEvent(
	event: AssistantMessageEvent,
	account: ResolvedAccount,
	poolProviderId: string,
	attempt: number,
	timestamp: number,
): AssistantMessageEvent {
	switch (event.type) {
		case "start":
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return {
				...event,
				partial: decorateAssistantMessage(event.partial, account, poolProviderId, attempt, timestamp),
			};
		case "done":
			return {
				...event,
				message: decorateAssistantMessage(event.message, account, poolProviderId, attempt, timestamp),
			};
		case "error":
			return {
				...event,
				error: decorateAssistantMessage(event.error, account, poolProviderId, attempt, timestamp),
			};
	}
}

export function eventHasMeaningfulOutput(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}
