import { describe, expect, mock, test } from "bun:test";

mock.module("@mariozechner/pi-coding-agent", () => ({
	estimateTokens(value: unknown) {
		return Math.ceil(JSON.stringify(value).length / 4);
	},
}));

const core = await import("../extensions/diligent-context/core.ts");

type EventMessage = import("../extensions/diligent-context/core.ts").EventMessage;
type ContentBlock = import("../extensions/diligent-context/core.ts").ContentBlock;

function assistantToolCall(args: {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
	thinking?: string;
}): EventMessage {
	const content: ContentBlock[] = [];
	if (args.thinking) {
		content.push({ type: "thinking", thinking: args.thinking });
	}
	content.push({
		type: "toolCall",
		id: args.id,
		name: args.name,
		arguments: args.arguments ?? {},
	});
	return { role: "assistant", content };
}

function assistantText(text: string): EventMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(toolCallId: string, text: string, isError = false): EventMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: text,
		isError,
	};
}

describe("diligent-context/core regression coverage", () => {
	test("resolveAnchorIndex prefers exact toolResult id matches over nearer text-only matches", () => {
		const messages: EventMessage[] = [
			toolResult("tail-id", "done"),
			toolResult("wrong-id", "done"),
			assistantText("intermediate"),
		];
		const fingerprint = {
			...core.computePayloadFingerprint(messages[0], 0),
			payloadIndex: 1,
		};
		expect(core.resolveAnchorIndex(messages, fingerprint)).toBe(0);
	});

	test("applyPruningAtBoundary preserves protected thinking assistant and linked tool result", () => {
		const messages: EventMessage[] = [
			assistantToolCall({ id: "call-1", name: "read", arguments: { path: "a.ts" } }),
			toolResult("call-1", "read ok"),
			assistantToolCall({
				id: "call-2",
				name: "edit",
				arguments: { path: "b.ts" },
				thinking: "need to patch this carefully",
			}),
			toolResult("call-2", "edit ok"),
		];

		const result = core.applyPruningAtBoundary(messages, 3, "after-entry");
		expect(result.changed).toBe(true);
		expect(result.filteredMessages).toHaveLength(2);
		expect(result.filteredMessages[0]?.role).toBe("assistant");
		expect(result.filteredMessages[1]?.role).toBe("toolResult");
		expect(core.getToolIdsFromAssistantMessage(result.filteredMessages[0] as EventMessage)).toEqual(["call-2"]);
		expect(core.getToolResultId(result.filteredMessages[1] as EventMessage)).toBe("call-2");
	});

	test("buildProvenanceCheckpoint includes boundary-crossing successful tool results", () => {
		const messages: EventMessage[] = [
			assistantToolCall({
				id: "move-1",
				name: "bash",
				arguments: { command: "mv src/old.ts src/new.ts" },
			}),
			toolResult("move-1", "rename complete"),
		];

		const checkpoint = core.buildProvenanceCheckpoint({
			rawMessages: messages,
			resolvedAnchorIndex: 0,
			anchorMode: "after-entry",
		});

		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.body).toContain("<moved>");
		expect(checkpoint?.body).toContain("- src/old.ts -> src/new.ts");
	});

	test("buildProvenanceCheckpoint suppresses no-op edits", () => {
		const checkpoint = core.buildProvenanceCheckpoint({
			rawMessages: [
				assistantToolCall({ id: "edit-1", name: "edit", arguments: { path: "src/app.ts" } }),
				toolResult("edit-1", "No changes applied"),
			],
			resolvedAnchorIndex: 1,
			anchorMode: "after-entry",
		});

		expect(checkpoint).toBeNull();
	});

	test("buildProvenanceCheckpoint ignores failed tool results", () => {
		const checkpoint = core.buildProvenanceCheckpoint({
			rawMessages: [
				assistantToolCall({ id: "write-err", name: "write", arguments: { path: "src/fail.ts" } }),
				toolResult("write-err", "permission denied", true),
			],
			resolvedAnchorIndex: 1,
			anchorMode: "after-entry",
		});

		expect(checkpoint).toBeNull();
	});

	test("buildProvenanceCheckpoint ignores tool calls without matching successful results", () => {
		const checkpoint = core.buildProvenanceCheckpoint({
			rawMessages: [assistantToolCall({ id: "write-missing", name: "write", arguments: { path: "src/missing.ts" } })],
			resolvedAnchorIndex: 0,
			anchorMode: "after-entry",
		});

		expect(checkpoint).toBeNull();
	});

	test("buildProvenanceCheckpoint parses head/tail file reads without treating numeric flags as paths", () => {
		const checkpoint = core.buildProvenanceCheckpoint({
			rawMessages: [
				assistantToolCall({
					id: "bash-1",
					name: "bash",
					arguments: { command: "head -n 20 src/file.txt" },
				}),
				toolResult("bash-1", "done"),
			],
			resolvedAnchorIndex: 1,
			anchorMode: "after-entry",
		});

		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.body).toContain("<read>");
		expect(checkpoint?.body).toContain("- src/file.txt");
		expect(checkpoint?.body).not.toContain("- 20");
	});

	test("buildProvenanceCheckpoint preserves write-after-move ordering", () => {
		const checkpoint = core.buildProvenanceCheckpoint({
			rawMessages: [
				assistantToolCall({
					id: "bash-2",
					name: "bash",
					arguments: { command: "mv old.ts new.ts && echo hi > old.ts" },
				}),
				toolResult("bash-2", "done"),
			],
			resolvedAnchorIndex: 1,
			anchorMode: "after-entry",
		});

		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.body).toContain("- old.ts -> new.ts");
		expect(checkpoint?.body).toContain("<written>\n- old.ts\n</written>");
		expect(checkpoint?.body).not.toContain("<written>\n- new.ts\n</written>");
	});
});
