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

function assistantToolCall(args: { id: string; name: string; arguments?: Record<string, unknown> }): EventMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: args.id,
				name: args.name,
				arguments: args.arguments ?? {},
			},
		],
	};
}

function toolResult(toolCallId: string, text: string, isError = false): EventMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: text,
		isError,
	};
}

function messageEntry(id: string, message: EventMessage): SessionEntry & { id: string; type: string; message: EventMessage } {
	return { id, type: "message", message };
}

function createHarness() {
	const branchEntries: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: unknown, ctx: any) => any>();
	let nextId = 1;
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(name: string, config: unknown) {
			const handler = (config as { handler?: (args: unknown, ctx: any) => any }).handler;
			if (typeof handler === "function") commands.set(name, handler);
		},
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
	return { branchEntries, handlers, commands, pi, ctx };
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

	test("lost-anchor recovery snapshot uses the recomputed post-recovery projection", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const rawMessages: EventMessage[] = [
			assistantToolCall({ id: "old-read", name: "read_file", arguments: { path: "hidden.ts" } }),
			toolResult("old-read", "hidden tool result"),
			userText("Please continue from the current visible work."),
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
					anchorFingerprint: core.computePayloadFingerprint(assistantText("old missing anchor"), 0),
				}),
			},
		);

		const contextHandler = harness.handlers.get("context")?.[0];
		expect(contextHandler).toBeDefined();
		const result = await contextHandler?.({ messages: rawMessages }, harness.ctx);

		const latestState = core.loadStateFromEntries(harness.branchEntries as SessionEntry[]);
		expect(latestState.enabled).toBe(true);
		expect(latestState.anchorMode).toBe("after-entry");

		const snapshot = core.getDiligentContextRuntimeSnapshot("session-1");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.resolvedAnchorIndex).toBe(3);
		expect(snapshot?.filteredToRawIndices).toEqual([2, 3]);
		expect(snapshot?.filteredMessages?.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(JSON.stringify(snapshot?.filteredMessages)).not.toContain("old-read");
		expect(JSON.stringify(snapshot?.filteredMessages)).not.toContain("hidden tool result");
		expect(result?.messages).toEqual(snapshot?.filteredMessages);
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

	test("pending-here materializes without preserving stale checkpoints", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const rawMessages = [userText("Please anchor on this next live payload.")];
		harness.branchEntries.push({
			id: "state-1",
			type: "custom",
			customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
			data: {
				enabled: true,
				anchorMode: "pending-here",
				anchorFingerprint: null,
				checkpoints: {
					provenance: core.buildCheckpointArtifact({
						kind: "provenance",
						body: "stale provenance",
						id: "stale-provenance",
						createdAt: "2026-05-24T00:00:00.000Z",
					}),
					contemplation: core.buildCheckpointArtifact({
						kind: "contemplation",
						body: "stale contemplation",
						id: "stale-contemplation",
						createdAt: "2026-05-24T00:00:00.000Z",
					}),
				},
			},
		});

		const contextHandler = harness.handlers.get("context")?.[0];
		await contextHandler?.({ messages: rawMessages }, harness.ctx);

		const latestState = core.loadStateFromEntries(harness.branchEntries as SessionEntry[]);
		expect(latestState.anchorMode).toBe("after-entry");
		expect(latestState.checkpoints).toEqual(core.EMPTY_CHECKPOINTS);
	});

	test("context hook projects checkpoints while runtime snapshot remains raw-grounded", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const rawMessages = [userText("anchor"), assistantText("visible tail")];
		const checkpoint = core.buildCheckpointArtifact({
			kind: "contemplation",
			body: "project this checkpoint only at context return",
			id: "contemplation-1",
			createdAt: "2026-05-24T00:00:00.000Z",
		});
		const state = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(rawMessages[0], 0),
			checkpoints: { contemplation: checkpoint },
		});
		harness.branchEntries.push(
			...rawMessages.map((message, index) => messageEntry(`msg-${index + 1}`, message)),
			{
				id: "state-1",
				type: "custom",
				customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
				data: state,
			},
		);

		const contextHandler = harness.handlers.get("context")?.[0];
		const result = await contextHandler?.({ messages: rawMessages }, harness.ctx);

		expect(JSON.stringify(result?.messages?.[0])).toContain("[Diligent contemplation checkpoint]");
		expect(JSON.stringify(result?.messages?.[0])).toContain("project this checkpoint only at context return");

		const snapshot = core.getDiligentContextRuntimeSnapshot("session-1");
		expect(snapshot?.rawMessages).toHaveLength(rawMessages.length);
		expect(snapshot?.filteredMessages).toHaveLength(rawMessages.length);
		expect(snapshot?.filteredToRawIndices).toEqual([0, 1]);
		expect(JSON.stringify(snapshot?.rawMessages)).not.toContain("project this checkpoint only at context return");
		expect(JSON.stringify(snapshot?.filteredMessages)).not.toContain("project this checkpoint only at context return");
	});

	test("manual re-anchor clears contemplation and regenerates provenance", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const rawMessages = [
			assistantToolCall({ id: "write-1", name: "bash", arguments: { command: "echo hi > src/new.ts" } }),
			toolResult("write-1", "wrote file"),
			assistantText("Finished writing the file."),
		];
		const previousState = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(rawMessages[0], 0),
			checkpoints: {
				provenance: core.buildCheckpointArtifact({
					kind: "provenance",
					body: "stale provenance",
					id: "old-provenance",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
				contemplation: core.buildCheckpointArtifact({
					kind: "contemplation",
					body: "stale contemplation",
					id: "old-contemplation",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
			},
		});
		harness.branchEntries.push(
			...rawMessages.map((message, index) => messageEntry(`msg-${index + 1}`, message)),
			{
				id: "state-1",
				type: "custom",
				customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
				data: previousState,
			},
		);

		const contextHandler = harness.handlers.get("context")?.[0];
		await contextHandler?.({ messages: rawMessages }, harness.ctx);
		const commandHandler = harness.commands.get("diligent-context");
		expect(commandHandler).toBeDefined();
		await commandHandler?.("here", harness.ctx);

		const latestState = core.loadStateFromEntries(harness.branchEntries as SessionEntry[]);
		expect(latestState.anchorMode).toBe("after-entry");
		expect(latestState.checkpoints.contemplation).toBeNull();
		expect(latestState.checkpoints.provenance).not.toBeNull();
		expect(latestState.checkpoints.provenance?.id).not.toBe("old-provenance");
		expect(latestState.checkpoints.provenance?.body).toContain("<written>");
		expect(latestState.checkpoints.provenance?.body).toContain("- src/new.ts");
	});

	test("session_compact clears active checkpoints by appending updated diligent state", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const activeState = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(userText("anchor"), 0),
			checkpoints: {
				provenance: core.buildCheckpointArtifact({
					kind: "provenance",
					body: "read src/a.ts",
					id: "provenance-1",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
				contemplation: core.buildCheckpointArtifact({
					kind: "contemplation",
					body: "remember this",
					id: "contemplation-1",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
			},
		});
		harness.branchEntries.push({
			id: "state-1",
			type: "custom",
			customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
			data: activeState,
		});
		const beforeCount = harness.branchEntries.length;

		const compactHandler = harness.handlers.get("session_compact")?.[0];
		expect(compactHandler).toBeDefined();
		await compactHandler?.({}, harness.ctx);

		expect(harness.branchEntries.length).toBe(beforeCount + 1);
		const latestState = core.loadStateFromEntries(harness.branchEntries as SessionEntry[]);
		expect(latestState.checkpoints).toEqual(core.EMPTY_CHECKPOINTS);
	});

	test("lost-anchor recovery does not preserve stale checkpoints from the lost boundary", async () => {
		const harness = createHarness();
		diligentContextExtension(harness.pi as any);

		const rawMessages = [userText("Please continue."), assistantText("Working on it.")];
		const staleState = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(assistantText("old anchor"), 0),
			checkpoints: {
				provenance: core.buildCheckpointArtifact({
					kind: "provenance",
					body: "stale provenance",
					id: "stale-provenance",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
				contemplation: core.buildCheckpointArtifact({
					kind: "contemplation",
					body: "stale contemplation",
					id: "stale-contemplation",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
			},
		});
		harness.branchEntries.push(
			...rawMessages.map((message, index) => messageEntry(`msg-${index + 1}`, message)),
			{
				id: "state-1",
				type: "custom",
				customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
				data: staleState,
			},
		);

		const contextHandler = harness.handlers.get("context")?.[0];
		await contextHandler?.({ messages: rawMessages }, harness.ctx);

		const latestState = core.loadStateFromEntries(harness.branchEntries as SessionEntry[]);
		expect(latestState.anchorMode).toBe("after-entry");
		expect(latestState.checkpoints.contemplation).toBeNull();
		expect(latestState.checkpoints.provenance).toBeNull();
	});
});
