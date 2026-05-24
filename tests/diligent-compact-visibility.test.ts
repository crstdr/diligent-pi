import { describe, expect, mock, test } from "bun:test";

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
	serializeConversation: (value: unknown) => JSON.stringify(value),
	estimateTokens(value: unknown) {
		if (value && typeof value === "object" && typeof (value as { testTokens?: unknown }).testTokens === "number") {
			return (value as { testTokens: number }).testTokens;
		}
		const text = extractText(value);
		if (text.startsWith("[Diligent contemplation checkpoint]")) return 31;
		if (text.startsWith("[Diligent provenance checkpoint]")) return 17;
		return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
	},
}));

const core = await import("../extensions/diligent-context/core.ts");
const visibility = await import("../extensions/diligent-compact/visibility.ts");

type EventMessage = import("../extensions/diligent-context/core.ts").EventMessage;
type SessionEntry = import("../extensions/diligent-context/core.ts").SessionEntry;
type DiligentContextState = import("../extensions/diligent-context/core.ts").DiligentContextState;
type DiligentContextRuntimeSnapshot = import("../extensions/diligent-context/core.ts").DiligentContextRuntimeSnapshot;
type ContextMessageEntry = import("../extensions/diligent-context/core.ts").ContextMessageEntry;
type CompactionPreparation = import("../extensions/diligent-compact/visibility.ts").CompactionPreparation;
type VisiblePreparationBuildResult = import("../extensions/diligent-compact/visibility.ts").VisiblePreparationBuildResult;

function extractText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const message = value as { content?: unknown; summary?: unknown };
	if (typeof message.summary === "string") return message.summary;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block) => block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
			? (block as { text: string }).text
			: "")
		.filter(Boolean)
		.join("\n");
}

function userText(text: string, testTokens = 4): EventMessage {
	return { role: "user", content: [{ type: "text", text }], testTokens };
}

function assistantText(text: string, testTokens = 4): EventMessage {
	return { role: "assistant", content: [{ type: "text", text }], testTokens };
}

function assistantToolCall(args: { id: string; name: string; path?: string; testTokens?: number }): EventMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: args.id,
				name: args.name,
				arguments: args.path ? { path: args.path } : {},
			},
		],
		testTokens: args.testTokens ?? 4,
	};
}

function messageEntry(id: string, message: EventMessage): SessionEntry & { id: string; type: "message"; message: EventMessage } {
	return { id, type: "message", message };
}

function entriesFor(messages: EventMessage[]): Array<SessionEntry & { id: string; type: "message"; message: EventMessage }> {
	return messages.map((message, index) => messageEntry(`msg-${index + 1}`, message));
}

function makePreparation(overrides: Record<string, unknown> = {}): CompactionPreparation {
	return {
		settings: { keepRecentTokens: 0, reserveTokens: 12000 },
		messagesToSummarize: [assistantText("original summarize payload")],
		turnPrefixMessages: [userText("original prefix")],
		isSplitTurn: true,
		previousSummary: "original previous summary",
		firstKeptEntryId: "original-entry",
		tokensBefore: 999,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		...overrides,
	} as CompactionPreparation;
}

function snapshot(args: {
	rawMessages?: EventMessage[] | null;
	filteredMessages?: EventMessage[] | null;
	filteredToRawIndices?: number[];
	state?: DiligentContextState;
	resolvedAnchorIndex?: number | null;
} = {}): DiligentContextRuntimeSnapshot {
	const rawMessages = args.rawMessages === undefined ? [] : args.rawMessages;
	const filteredMessages = args.filteredMessages === undefined ? rawMessages : args.filteredMessages;
	return {
		state: args.state ?? core.OFF_STATE,
		rawMessages,
		filteredMessages,
		filteredToRawIndices: args.filteredToRawIndices ?? (filteredMessages ?? []).map((_, index) => index),
		resolvedAnchorIndex: args.resolvedAnchorIndex ?? null,
	};
}

function expectFailure(
	result: VisiblePreparationBuildResult,
): Extract<VisiblePreparationBuildResult, { ok: false }> {
	expect(result.ok).toBe(false);
	return result as Extract<VisiblePreparationBuildResult, { ok: false }>;
}

function expectSuccess(
	result: VisiblePreparationBuildResult,
): Extract<VisiblePreparationBuildResult, { ok: true }> {
	expect(result.ok).toBe(true);
	return result as Extract<VisiblePreparationBuildResult, { ok: true }>;
}

describe("diligent-compact/visibility route selection", () => {
	test("computeCompactionRoute preserves native, compatibility, opinionated, and force-native precedence", () => {
		expect(visibility.computeCompactionRoute({ diligentEnabled: false })).toBe("native");
		expect(visibility.computeCompactionRoute({ diligentEnabled: true })).toBe("compatibility");
		expect(visibility.computeCompactionRoute({ pendingMode: "opinionated", diligentEnabled: false })).toBe("opinionated");
		expect(visibility.computeCompactionRoute({ pendingMode: "opinionated", diligentEnabled: true })).toBe("opinionated");
		expect(visibility.computeCompactionRoute({ pendingMode: "force-native", diligentEnabled: false })).toBe("force-native");
		expect(visibility.computeCompactionRoute({ pendingMode: "force-native", diligentEnabled: true })).toBe("force-native");
	});
});

describe("diligent-compact/visibility alignment", () => {
	test("alignRawMessagesToContextEntries skips visible custom messages while mapping raw message ids", () => {
		const rawMessages = [userText("hello"), assistantText("world")];
		const contextEntries: ContextMessageEntry[] = [
			{ id: "msg-1", sourceType: "message", message: rawMessages[0] },
			{ id: "custom-1", sourceType: "custom_message", message: { role: "custom", customType: "notice" } },
			{ id: "msg-2", sourceType: "message", message: rawMessages[1] },
		];

		const result = visibility.alignRawMessagesToContextEntries(rawMessages, contextEntries);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.rawIndexToEntryId).toEqual(["msg-1", "msg-2"]);
		expect(result.stats.skippedCustomMessageCount).toBe(1);
		expect(result.stats.requiredContextEntryCount).toBe(2);
	});

	test("alignRawMessagesToContextEntries reports context-tail and raw-tail diagnostics", () => {
		const rawMessages = [userText("hello"), assistantText("world")];
		const requiredContextTail = visibility.alignRawMessagesToContextEntries(
			[rawMessages[0]],
			[
				{ id: "msg-1", sourceType: "message", message: rawMessages[0] },
				{ id: "msg-2", sourceType: "message", message: rawMessages[1] },
			],
		);
		expect(requiredContextTail.ok).toBe(false);
		if (requiredContextTail.ok) return;
		expect(requiredContextTail.diagnostic.kind).toBe("required-context-tail");
		expect(requiredContextTail.diagnostic.rawIndex).toBe(1);
		expect(requiredContextTail.diagnostic.contextIndex).toBe(1);

		const unmatchedRawTail = visibility.alignRawMessagesToContextEntries(
			rawMessages,
			[{ id: "msg-1", sourceType: "message", message: rawMessages[0] }],
		);
		expect(unmatchedRawTail.ok).toBe(false);
		if (unmatchedRawTail.ok) return;
		expect(unmatchedRawTail.diagnostic.kind).toBe("unmatched-raw-tail");
		expect(unmatchedRawTail.diagnostic.rawIndex).toBe(1);
		expect(unmatchedRawTail.diagnostic.contextIndex).toBe(1);
	});
});

describe("diligent-compact/visibility preparation failures", () => {
	test("buildVisiblePreparation reports no live payload before route-specific side effects run", () => {
		const result = visibility.buildVisiblePreparation(null, core.OFF_STATE, makePreparation(), []);

		const failure = expectFailure(result);
		expect(failure.reason).toBe("no-live-payload");
		expect(failure.message).toContain("no live visible context");
	});

	test("buildVisiblePreparation distinguishes restoring and lost anchors", () => {
		const liveMessages = [userText("hello")];
		const restoringState: DiligentContextState = {
			enabled: true,
			anchorMode: "pending-here",
			anchorFingerprint: null,
			checkpoints: { provenance: null, contemplation: null },
		};
		const restoring = visibility.buildVisiblePreparation(
			snapshot({ rawMessages: liveMessages, state: restoringState }),
			restoringState,
			makePreparation(),
			entriesFor(liveMessages),
		);
		const restoringFailure = expectFailure(restoring);
		expect(restoringFailure.reason).toBe("anchor-restoring");
		expect(restoringFailure.message).toContain("still restoring");

		const lostState = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(assistantText("old anchor"), 0),
		});
		const lost = visibility.buildVisiblePreparation(
			snapshot({ rawMessages: liveMessages, state: lostState }),
			lostState,
			makePreparation(),
			entriesFor(liveMessages),
		);
		const lostFailure = expectFailure(lost);
		expect(lostFailure.reason).toBe("anchor-restoring");
		expect(lostFailure.message).toContain("anchor was lost");
	});

	test("buildVisiblePreparation reports filtered/raw mapping length diagnostics", () => {
		const rawMessages = [userText("one"), assistantText("two")];
		const result = visibility.buildVisiblePreparation(
			snapshot({ rawMessages, filteredMessages: rawMessages, filteredToRawIndices: [0] }),
			core.OFF_STATE,
			makePreparation(),
			entriesFor(rawMessages),
		);

		const failure = expectFailure(result);
		expect(failure.reason).toBe("context-mapping-mismatch");
		expect(failure.diagnostic).toEqual({
			kind: "filtered-to-raw-length-mismatch",
			filteredMessageCount: 2,
			filteredToRawCount: 1,
			rawMessageCount: 2,
		});
	});

	test("buildVisiblePreparation reports raw/context mismatch diagnostics", () => {
		const rawMessages = [userText("same"), assistantText("actual")];
		const branchEntries = [messageEntry("msg-1", rawMessages[0]), messageEntry("msg-2", assistantText("expected"))];
		const result = visibility.buildVisiblePreparation(
			snapshot({ rawMessages, filteredMessages: rawMessages, filteredToRawIndices: [0, 1] }),
			core.OFF_STATE,
			makePreparation(),
			branchEntries,
		);

		const failure = expectFailure(result);
		expect(failure.reason).toBe("context-mapping-mismatch");
		expect(failure.diagnostic?.kind).toBe("raw-context-alignment-divergence");
		if (failure.diagnostic?.kind !== "raw-context-alignment-divergence") return;
		expect(failure.diagnostic.alignment.kind).toBe("required-entry-mismatch");
		expect(failure.diagnostic.alignment.rawIndex).toBe(1);
		expect(failure.diagnostic.alignment.contextIndex).toBe(1);
		expect(failure.diagnostic.alignment.mismatchFields).toContain("text");
		expect(failure.diagnostic.alignment.stats.matchedPrefixCount).toBe(1);
	});

	test("buildVisiblePreparation reports first-kept mapping diagnostics when the visible cut cannot map to a session entry", () => {
		const rawMessages = [userText("summarize this"), assistantText("keep this")];
		const result = visibility.buildVisiblePreparation(
			snapshot({ rawMessages, filteredMessages: rawMessages, filteredToRawIndices: [0, 99] }),
			core.OFF_STATE,
			makePreparation(),
			entriesFor(rawMessages),
		);

		const failure = expectFailure(result);
		expect(failure.reason).toBe("context-mapping-mismatch");
		expect(failure.diagnostic).toEqual({
			kind: "first-kept-entry-id-missing",
			firstKeptVisibleIndex: 1,
			firstKeptRawIndex: 99,
			rawMessageCount: 2,
			mappingCount: 2,
		});
	});

	test("buildVisiblePreparation reports nothing visible to compact", () => {
		const rawMessages = [userText("only visible message")];
		const result = visibility.buildVisiblePreparation(
			snapshot({ rawMessages, filteredMessages: rawMessages, filteredToRawIndices: [0] }),
			core.OFF_STATE,
			makePreparation(),
			entriesFor(rawMessages),
		);

		const failure = expectFailure(result);
		expect(failure.reason).toBe("nothing-visible-to-compact");
		expect(failure.message).toContain("nothing visible to compact");
	});
});

describe("diligent-compact/visibility preparation success", () => {
	test("buildVisiblePreparation maps the first kept visible entry through raw session ids", () => {
		const rawMessages = [
			userText("hidden but raw", 3),
			assistantToolCall({ id: "call-1", name: "write", path: "src/changed.ts", testTokens: 5 }),
			userText("keep this", 7),
		];
		const result = visibility.buildVisiblePreparation(
			snapshot({
				rawMessages,
				filteredMessages: [rawMessages[1], rawMessages[2]],
				filteredToRawIndices: [1, 2],
			}),
			core.OFF_STATE,
			makePreparation(),
			entriesFor(rawMessages),
		);

		const success = expectSuccess(result);
		expect(success.preparation.firstKeptEntryId).toBe("msg-3");
		expect(success.preparation.messagesToSummarize).toEqual([rawMessages[1]]);
		expect(success.preparation.turnPrefixMessages).toEqual([]);
		expect(success.preparation.isSplitTurn).toBe(false);
		expect(Array.from((success.preparation.fileOps as { written: Set<string> }).written)).toEqual(["src/changed.ts"]);
		expect(success.totalVisibleMessages).toBe(2);
		expect(success.summarizedVisibleMessages).toBe(1);
		expect(success.keptVisibleMessages).toBe(1);
	});

	test("buildVisiblePreparation honors positive keepRecentTokens when choosing the first kept visible entry", () => {
		const rawMessages = [
			userText("old one", 40),
			assistantText("old two", 30),
			userText("recent one", 10),
			assistantText("recent two", 10),
		];
		const result = visibility.buildVisiblePreparation(
			snapshot({ rawMessages, filteredMessages: rawMessages, filteredToRawIndices: [0, 1, 2, 3] }),
			core.OFF_STATE,
			makePreparation({ settings: { keepRecentTokens: 15, reserveTokens: 12000 } }),
			entriesFor(rawMessages),
		);

		const success = expectSuccess(result);
		expect(success.preparation.firstKeptEntryId).toBe("msg-4");
		expect(success.preparation.messagesToSummarize).toEqual(rawMessages.slice(0, 3));
		expect(success.summarizedVisibleMessages).toBe(3);
		expect(success.keptVisibleMessages).toBe(1);
	});

	test("buildVisiblePreparation carries checkpoint previousSummary and accounts projected checkpoint tokens", () => {
		const rawMessages = [userText("summarize this", 10), assistantText("keep this", 20)];
		const state = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(rawMessages[0], 0),
			checkpoints: {
				contemplation: {
					id: "contemplation-1",
					kind: "contemplation",
					body: "Remember the design decision.",
					createdAt: "2026-05-24T00:00:00.000Z",
				},
				provenance: {
					id: "provenance-1",
					kind: "provenance",
					body: "<written>\n- src/file.ts\n</written>",
					createdAt: "2026-05-24T00:00:00.000Z",
				},
			},
		});
		const result = visibility.buildVisiblePreparation(
			snapshot({ rawMessages, filteredMessages: rawMessages, filteredToRawIndices: [0, 1], state, resolvedAnchorIndex: 0 }),
			state,
			makePreparation(),
			entriesFor(rawMessages),
		);

		const success = expectSuccess(result);
		expect(success.preparation.previousSummary).toContain("[Diligent contemplation checkpoint]");
		expect(success.preparation.previousSummary).toContain("Remember the design decision.");
		expect(success.preparation.previousSummary).toContain("[Diligent provenance checkpoint]");
		expect(success.preparation.previousSummary).toContain("src/file.ts");
		expect(success.preparation.tokensBefore).toBe(10 + 20 + 31 + 17);
		expect(success.anchorSignature).toContain('"anchorMode":"after-entry"');
	});
});
