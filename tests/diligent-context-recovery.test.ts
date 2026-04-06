import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@mariozechner/pi-coding-agent", () => ({
	DynamicBorder: class DynamicBorder {
		constructor(_render: unknown) {}
	},
	CompactionSummaryMessageComponent: class CompactionSummaryMessageComponent {
		constructor(..._args: unknown[]) {}
		setExpanded(_value: boolean) {}
	},
	convertToLlm: (value: unknown) => value,
	getMarkdownTheme: () => ({}),
	serializeConversation: () => "",
	estimateTokens(value: unknown) {
		return Math.ceil(JSON.stringify(value).length / 4);
	},
}));

mock.module("@mariozechner/pi-tui", () => ({
	Container: class Container {
		addChild(_child: unknown) {}
		render(_width: number) {
			return "";
		}
		invalidate() {}
	},
	SelectList: class SelectList {
		onSelect?: (item: { value: string }) => void;
		onCancel?: () => void;
		constructor(_items: unknown[], _pageSize: number, _options: unknown) {}
		handleInput(_data: string) {}
	},
	Text: class Text {
		constructor(_text = "", _x = 0, _y = 0) {}
		setText(_text: string) {}
	},
}));

mock.module("../extensions/diligent-compact/shared.ts", () => ({
	CONFIG: { debugCompactions: false, thinkingLevel: "medium" },
	debugLog: () => {},
	readOptionalTextFile: (_path: string, fallback: string) => fallback,
	buildTaggedPromptText: (parts: Array<{ tag?: string; text?: string }>) =>
		parts.map((part) => part.text ?? "").filter(Boolean).join("\n\n"),
	runCompatibilityCompactionRequest: async ({ preparation }: { preparation: { firstKeptEntryId: string; tokensBefore: number } }) => ({
		summary: "compat summary",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
	}),
	runOpinionatedCompactionRequest: async ({ preparation }: { preparation: { firstKeptEntryId: string; tokensBefore: number } }) => ({
		summary: "opinionated summary",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
	}),
}));

const core = await import("../extensions/diligent-context/core.ts");
const { default: diligentContextExtension } = await import("../extensions/diligent-context/index.ts");
const { default: diligentCompactExtension } = await import("../extensions/diligent-compact/index.ts");

type EventMessage = import("../extensions/diligent-context/core.ts").EventMessage;
type SessionEntry = import("../extensions/diligent-context/core.ts").SessionEntry;

function userText(text: string): EventMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): EventMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function messageEntry(id: string, message: EventMessage): SessionEntry & { id: string; type: string; message: EventMessage } {
	return { id, type: "message", message };
}

function createHarness() {
	const branchEntries: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	let nextId = 1;
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(_name: string, _config: unknown) {},
		appendEntry(customType: string, data: unknown) {
			branchEntries.push({ id: `custom-${nextId++}`, type: "custom", customType, data });
		},
		sendMessage(message: { customType?: string; content?: unknown; display?: boolean; details?: unknown }) {
			branchEntries.push({
				id: `custom-message-${nextId++}`,
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				timestamp: new Date().toISOString(),
			});
		},
		getThinkingLevel() {
			return "medium" as const;
		},
	};
	const ctx = {
		hasUI: false,
		model: { provider: "openai-codex", id: "gpt-5.4" },
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branchEntries,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
		compact: () => {},
	};
	return { branchEntries, handlers, pi, ctx };
}

beforeEach(() => {
	core.setDiligentContextRuntimeSnapshot("session-1", null);
});

describe("diligent-context lost-anchor recovery", () => {
	test("context hook re-anchors when the stored anchor no longer exists in live payload", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const rawMessages: EventMessage[] = [
			userText("Please continue."),
			assistantText("Working on it."),
		];
		harness.branchEntries.push(
			...rawMessages.map((message, index) => messageEntry(`msg-${index + 1}`, message)),
			{
				id: "state-1",
				type: "custom",
				customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
				data: core.buildAnchoredState({
					anchorMode: "after-entry",
					anchorFingerprint: core.computePayloadFingerprint(assistantText("old anchor"), 0),
				}),
			},
		);

		const contextHandler = harness.handlers.get("context")?.[0];
		expect(contextHandler).toBeDefined();
		await contextHandler?.({ messages: rawMessages }, harness.ctx);

		const latestState = core.loadStateFromEntries(harness.branchEntries as SessionEntry[]);
		expect(latestState.enabled).toBe(true);
		expect(latestState.anchorMode).toBe("after-entry");
		const snapshot = core.getDiligentContextRuntimeSnapshot("session-1");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.resolvedAnchorIndex).toBe(1);
	});

	test("compatibility compaction no longer blocks on a previously lost anchor after recovery", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);
		diligentCompactExtension(harness.pi as any);

		const rawMessages: EventMessage[] = [
			userText("Please continue."),
			assistantText("Working on it."),
			userText("Now compact this."),
		];
		harness.branchEntries.push(
			...rawMessages.map((message, index) => messageEntry(`msg-${index + 1}`, message)),
			{
				id: "state-1",
				type: "custom",
				customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
				data: core.buildAnchoredState({
					anchorMode: "after-entry",
					anchorFingerprint: core.computePayloadFingerprint(assistantText("old anchor"), 0),
				}),
			},
		);

		const contextHandler = harness.handlers.get("context")?.[0];
		await contextHandler?.({ messages: rawMessages }, harness.ctx);

		const compactHandler = harness.handlers.get("session_before_compact")?.[0];
		expect(compactHandler).toBeDefined();
		const result = await compactHandler?.(
			{
				preparation: {
					settings: { keepRecentTokens: 0 },
					messagesToSummarize: [],
					turnPrefixMessages: [],
					isSplitTurn: false,
					previousSummary: undefined,
					tokensBefore: core.estimatePayloadTokens(rawMessages),
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				},
				branchEntries: harness.branchEntries,
				signal: new AbortController().signal,
				customInstructions: undefined,
			},
			harness.ctx,
		);

		expect(result?.cancel).toBeUndefined();
		expect(result?.compaction?.summary).toBe("compat summary");
	});
});
