import { beforeEach, describe, expect, mock, test } from "bun:test";

const completeSimpleCalls: unknown[][] = [];
let completeSimpleImpl: (...args: unknown[]) => Promise<{
	stopReason: string;
	content: Array<{ type: string; text?: string }>;
	errorMessage?: string;
}>;

mock.module("@mariozechner/pi-ai", () => ({
	completeSimple: async (...args: unknown[]) => {
		completeSimpleCalls.push(args);
		return completeSimpleImpl(...args);
	},
}));

mock.module("@mariozechner/pi-coding-agent", () => ({
	convertToLlm: (value: unknown) => value,
	serializeConversation: (value: unknown) => JSON.stringify(value),
	estimateTokens(value: unknown) {
		return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
	},
}));

const core = await import("../extensions/diligent-context/core.ts");
const { default: diligentContemplateExtension } = await import("../extensions/diligent-contemplate/index.ts");

type EventMessage = import("../extensions/diligent-context/core.ts").EventMessage;
type SessionEntry = import("../extensions/diligent-context/core.ts").SessionEntry;
type DiligentContextState = import("../extensions/diligent-context/core.ts").DiligentContextState;
type DiligentContextRuntimeSnapshot = import("../extensions/diligent-context/core.ts").DiligentContextRuntimeSnapshot;

type Notification = { text: string; level?: string };
type StatusUpdate = { key: string; text?: string };

type Harness = ReturnType<typeof createHarness>;

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

function model(provider: string, id: string, contextWindow = 128000): any {
	return { provider, id, contextWindow };
}

function stateEntry(id: string, state: DiligentContextState): SessionEntry & { id: string; type: string; customType: string; data: DiligentContextState } {
	return {
		id,
		type: "custom",
		customType: core.DILIGENT_CONTEXT_CUSTOM_TYPE,
		data: state,
	};
}

function configuredRegistry(args: {
	configuredModel?: any;
	auth?: Record<string, unknown>;
} = {}): any {
	const configuredModel = args.configuredModel ?? model("anthropic", "claude-opus-4-7");
	const auth = args.auth ?? { apiKey: "configured-key" };
	return {
		find: async (provider: string, id: string) => provider === configuredModel.provider && id === configuredModel.id ? configuredModel : undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, ...auth }),
	};
}

function noUsableModelRegistry(): any {
	return {
		find: async () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true }),
	};
}

function currentFallbackRegistry(): any {
	return {
		find: async () => undefined,
		getApiKeyAndHeaders: async (candidate: { provider?: string; id?: string }) => {
			if (candidate.provider === "openai-codex" && candidate.id === "gpt-5.4") {
				return { ok: true, apiKey: "current-key" };
			}
			return { ok: true };
		},
	};
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function createHarness(options: {
	sessionId?: string | null;
	hasUI?: boolean;
	model?: any;
	modelRegistry?: any;
	throwUiWhenStale?: boolean;
	throwSessionWhenStale?: boolean;
} = {}) {
	const branchEntries: Array<Record<string, unknown>> = [];
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	const sentMessages: Array<Record<string, unknown>> = [];
	const notifications: Notification[] = [];
	const statuses: StatusUpdate[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: unknown, ctx: any) => any>();
	let nextId = 1;
	let sessionId = options.sessionId === undefined ? "session-1" : options.sessionId;
	let stale = false;

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
			appendEntries.push({ customType, data });
			branchEntries.push({ id: `custom-${nextId++}`, type: "custom", customType, data });
		},
		sendMessage(message: Record<string, unknown>) {
			sentMessages.push(message);
			branchEntries.push({
				id: `custom-message-${nextId++}`,
				type: "custom_message",
				...message,
			});
		},
		getThinkingLevel() {
			return "medium" as const;
		},
	};

	const ctx = {
		hasUI: options.hasUI ?? true,
		model: options.model ?? model("openai-codex", "gpt-5.4"),
		modelRegistry: options.modelRegistry ?? configuredRegistry(),
		sessionManager: {
			getSessionId: () => {
				if (stale && options.throwSessionWhenStale) throw new Error("stale session manager");
				return sessionId;
			},
			getBranch: () => {
				if (stale && options.throwSessionWhenStale) throw new Error("stale branch access");
				return branchEntries;
			},
		},
		ui: {
			notify: (text: string, level?: string) => {
				if (stale && options.throwUiWhenStale) throw new Error("stale notify");
				notifications.push({ text, level });
			},
			setStatus: (key: string, text?: string) => {
				if (stale && options.throwUiWhenStale) throw new Error("stale status");
				statuses.push({ key, text });
			},
			theme: { fg: (_tone: string, text: string) => text },
		},
	};

	diligentContemplateExtension(pi as any);

	return {
		branchEntries,
		appendEntries,
		sentMessages,
		notifications,
		statuses,
		handlers,
		commands,
		pi,
		ctx,
		get sessionId() {
			return sessionId;
		},
		setSessionId(next: string | null) {
			sessionId = next;
		},
		markStale() {
			stale = true;
		},
	};
}

function installSnapshot(harness: Harness, snapshot: DiligentContextRuntimeSnapshot): void {
	const sessionId = harness.sessionId;
	if (!sessionId) throw new Error("test harness requires a session id to install snapshot");
	core.setDiligentContextRuntimeSnapshot(sessionId, snapshot);
	harness.branchEntries.push(stateEntry(`state-${harness.branchEntries.length + 1}`, snapshot.state));
}

function installRawSnapshot(
	harness: Harness,
	rawMessages: EventMessage[],
	state: DiligentContextState = core.OFF_STATE,
): DiligentContextRuntimeSnapshot {
	const snapshot = core.buildRuntimeSnapshotFromRawMessages(rawMessages, state);
	installSnapshot(harness, snapshot);
	return snapshot;
}

async function runCommand(harness: Harness, args = ""): Promise<void> {
	const handler = harness.commands.get("diligent-contemplate");
	expect(handler).toBeDefined();
	await handler?.(args, harness.ctx);
}

function expectNoContextWrites(harness: Harness): void {
	expect(harness.appendEntries.filter((entry) => entry.customType === core.DILIGENT_CONTEXT_CUSTOM_TYPE)).toEqual([]);
}

function expectNotificationContaining(harness: Harness, text: string): void {
	expect(harness.notifications.some((notification) => notification.text.includes(text))).toBe(true);
}

async function expectInvalidMappingBlocked(snapshot: DiligentContextRuntimeSnapshot): Promise<void> {
	completeSimpleCalls.length = 0;
	const harness = createHarness();
	installSnapshot(harness, snapshot);

	await runCommand(harness);

	expectNoContextWrites(harness);
	expect(completeSimpleCalls).toHaveLength(0);
	expectNotificationContaining(harness, "invalid diligent-visible mapping");
}

async function expectPostGenerationSnapshotMutationAborts(
	initialSnapshot: DiligentContextRuntimeSnapshot,
	mutate: (harness: Harness) => void,
): Promise<void> {
	const harness = createHarness();
	installSnapshot(harness, initialSnapshot);
	completeSimpleImpl = async () => {
		mutate(harness);
		return { stopReason: "stop", content: [{ type: "text", text: "Generated checkpoint." }] };
	};

	await runCommand(harness);

	expectNoContextWrites(harness);
	expectNotificationContaining(harness, "live visible context changed");
}

beforeEach(() => {
	completeSimpleCalls.length = 0;
	completeSimpleImpl = async () => ({
		stopReason: "stop",
		content: [{ type: "text", text: "Generated contemplation checkpoint." }],
	});
	core.setDiligentContextRuntimeSnapshot("session-1", null);
	core.setDiligentContextRuntimeSnapshot("session-2", null);
});

describe("diligent-contemplate command safety guards", () => {
	test("warns and writes nothing with no active session", async () => {
		const harness = createHarness({ sessionId: null });

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "no active session");
	});

	test("warns and writes nothing without a runtime snapshot", async () => {
		const harness = createHarness();

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "no current diligent-visible live context");
	});

	test("rejects concurrent invocations before model selection resolves", async () => {
		const gate = deferred();
		const configured = model("anthropic", "claude-opus-4-7");
		const harness = createHarness({
			modelRegistry: {
				find: async (provider: string, id: string) => {
					await gate.promise;
					return provider === configured.provider && id === configured.id ? configured : undefined;
				},
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "configured-key" }),
			},
		});
		installRawSnapshot(harness, [userText("visible context")]);

		const firstRun = runCommand(harness);
		await Promise.resolve();
		await Promise.resolve();
		await runCommand(harness);

		expectNotificationContaining(harness, "already running");
		expect(completeSimpleCalls).toHaveLength(0);
		gate.resolve();
		await firstRun;
		expect(completeSimpleCalls).toHaveLength(1);
	});

	test("does not call the model when the active session changes during model selection", async () => {
		const configured = model("anthropic", "claude-opus-4-7");
		let harness!: Harness;
		const registry = {
			find: async (provider: string, id: string) => {
				harness.setSessionId("session-2");
				return provider === configured.provider && id === configured.id ? configured : undefined;
			},
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "configured-key" }),
		};
		harness = createHarness({ modelRegistry: registry });
		installRawSnapshot(harness, [userText("visible context")]);

		await runCommand(harness);

		expectNoContextWrites(harness);
		expect(completeSimpleCalls).toHaveLength(0);
		expectNotificationContaining(harness, "active session changed");
	});

	test("warns and writes nothing when visible mapping is invalid", async () => {
		const harness = createHarness();
		installSnapshot(harness, {
			state: core.OFF_STATE,
			rawMessages: [userText("hello")],
			filteredMessages: [userText("hello")],
			filteredToRawIndices: [],
			resolvedAnchorIndex: null,
		});

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "invalid diligent-visible mapping");
	});

	test("rejects in-range filtered-to-raw mappings whose messages do not match", async () => {
		const rawMessages = [userText("raw one"), assistantText("raw two")];
		await expectInvalidMappingBlocked({
			state: core.OFF_STATE,
			rawMessages,
			filteredMessages: [rawMessages[1]],
			filteredToRawIndices: [0],
			resolvedAnchorIndex: null,
		});
	});

	test("rejects out-of-range middle filtered-to-raw indices", async () => {
		const rawMessages = [userText("one"), assistantText("two"), userText("three")];
		await expectInvalidMappingBlocked({
			state: core.OFF_STATE,
			rawMessages,
			filteredMessages: rawMessages,
			filteredToRawIndices: [0, 99, 2],
			resolvedAnchorIndex: null,
		});
	});

	test("rejects duplicate filtered-to-raw indices", async () => {
		const rawMessages = [userText("one"), assistantText("two")];
		await expectInvalidMappingBlocked({
			state: core.OFF_STATE,
			rawMessages,
			filteredMessages: rawMessages,
			filteredToRawIndices: [0, 0],
			resolvedAnchorIndex: null,
		});
	});

	test("rejects negative filtered-to-raw indices", async () => {
		const rawMessages = [userText("one")];
		await expectInvalidMappingBlocked({
			state: core.OFF_STATE,
			rawMessages,
			filteredMessages: rawMessages,
			filteredToRawIndices: [-1],
			resolvedAnchorIndex: null,
		});
	});

	test("rejects non-integer filtered-to-raw indices", async () => {
		const rawMessages = [userText("one")];
		await expectInvalidMappingBlocked({
			state: core.OFF_STATE,
			rawMessages,
			filteredMessages: rawMessages,
			filteredToRawIndices: [0.5],
			resolvedAnchorIndex: null,
		});
	});

	test("rejects out-of-order filtered-to-raw indices", async () => {
		const rawMessages = [userText("one"), assistantText("two")];
		await expectInvalidMappingBlocked({
			state: core.OFF_STATE,
			rawMessages,
			filteredMessages: [rawMessages[1], rawMessages[0]],
			filteredToRawIndices: [1, 0],
			resolvedAnchorIndex: null,
		});
	});

	test("accepts valid filtered derivatives from diligent-context tool-call pruning", async () => {
		const harness = createHarness();
		const assistantWithTextAndTool: EventMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the file." },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
			],
		};
		const rawMessages = [
			assistantWithTextAndTool,
			toolResult("read-1", "file contents"),
			userText("visible tail"),
		];
		const state = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(rawMessages[0], 0),
		});
		const snapshot = core.buildRuntimeSnapshotFromRawMessages(rawMessages, state);
		expect(snapshot.filteredToRawIndices).toEqual([0, 2]);
		expect(snapshot.filteredMessages?.[0]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "I will inspect the file." }],
		});
		installSnapshot(harness, snapshot);

		await runCommand(harness);

		expect(harness.notifications.some((notification) => notification.text.includes("invalid diligent-visible mapping"))).toBe(false);
		expect(harness.appendEntries.filter((entry) => entry.customType === core.DILIGENT_CONTEXT_CUSTOM_TYPE)).toHaveLength(1);
	});

	test("warns and writes nothing when the anchor is lost", async () => {
		const harness = createHarness();
		const rawMessages = [userText("current payload")];
		const state = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(assistantText("old missing anchor"), 0),
		});
		installRawSnapshot(harness, rawMessages, state);

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "anchor was lost");
	});

	test("warns and writes nothing while the boundary is still restoring", async () => {
		const harness = createHarness();
		installRawSnapshot(harness, [userText("current payload")], {
			enabled: true,
			anchorMode: "pending-here",
			anchorFingerprint: null,
			checkpoints: core.EMPTY_CHECKPOINTS,
		});

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "still restoring");
	});

	test("warns and writes nothing for duplicate active contemplation with no new messages", async () => {
		const harness = createHarness();
		const rawMessages = [userText("already represented")];
		const state = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(rawMessages[0], 0),
			checkpoints: {
				contemplation: core.buildCheckpointArtifact({
					kind: "contemplation",
					body: "already represented",
					id: "contemplation-existing",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
			},
		});
		installRawSnapshot(harness, rawMessages, state);

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "nothing new has happened");
	});

	test("warns and writes nothing when no configured or current model auth is usable", async () => {
		const harness = createHarness({ modelRegistry: noUsableModelRegistry() });
		installRawSnapshot(harness, [userText("visible context")]);

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "no model auth available");
	});

	test("warns and writes nothing when prompt budget fails", async () => {
		const harness = createHarness({
			modelRegistry: configuredRegistry({ configuredModel: model("anthropic", "claude-opus-4-7", 100) }),
		});
		installRawSnapshot(harness, [userText("visible context")]);

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "prompt too large");
	});

	test("warns and writes nothing on empty model output", async () => {
		const harness = createHarness();
		installRawSnapshot(harness, [userText("visible context")]);
		completeSimpleImpl = async () => ({ stopReason: "stop", content: [] });

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "empty output");
	});

	test("aborts and writes nothing when the live snapshot mutates after generation", async () => {
		const harness = createHarness();
		const rawMessages = [userText("visible context")];
		installRawSnapshot(harness, rawMessages);
		completeSimpleImpl = async () => {
			if (!harness.sessionId) throw new Error("missing session");
			core.setDiligentContextRuntimeSnapshot(
				harness.sessionId,
				core.buildRuntimeSnapshotFromRawMessages([...rawMessages, assistantText("new tail")], core.OFF_STATE),
			);
			return { stopReason: "stop", content: [{ type: "text", text: "Generated checkpoint." }] };
		};

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "live visible context changed");
	});

	test("aborts when long text changes after the old comparable prefix", async () => {
		const prefix = "x".repeat(160);
		const initialSnapshot = core.buildRuntimeSnapshotFromRawMessages([
			assistantText(`${prefix} original tail`),
		], core.OFF_STATE);

		await expectPostGenerationSnapshotMutationAborts(initialSnapshot, (harness) => {
			if (!harness.sessionId) throw new Error("missing session");
			core.setDiligentContextRuntimeSnapshot(harness.sessionId, core.buildRuntimeSnapshotFromRawMessages([
				assistantText(`${prefix} changed tail`),
			], core.OFF_STATE));
		});
	});

	test("aborts when tool-call arguments change without changing comparable tool names", async () => {
		const initialSnapshot = core.buildRuntimeSnapshotFromRawMessages([
			assistantToolCall({ id: "read-1", name: "read", arguments: { path: "src/a.ts" } }),
		], core.OFF_STATE);

		await expectPostGenerationSnapshotMutationAborts(initialSnapshot, (harness) => {
			if (!harness.sessionId) throw new Error("missing session");
			core.setDiligentContextRuntimeSnapshot(harness.sessionId, core.buildRuntimeSnapshotFromRawMessages([
				assistantToolCall({ id: "read-1", name: "read", arguments: { path: "src/b.ts" } }),
			], core.OFF_STATE));
		});
	});

	test("aborts when hidden raw prefix changes even though visible summaries stay unchanged", async () => {
		const initialRaw = [
			assistantToolCall({ id: "read-1", name: "bash", arguments: { command: "cat src/a.ts" } }),
			toolResult("read-1", "read ok"),
			userText("visible summary stays the same"),
		];
		const state = core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(initialRaw[1], 1),
			checkpoints: {
				provenance: core.buildCheckpointArtifact({
					kind: "provenance",
					body: "<read>\n- src/a.ts\n</read>",
					id: "provenance-a",
					createdAt: "2026-05-24T00:00:00.000Z",
				}),
			},
		});
		const initialSnapshot = core.buildRuntimeSnapshotFromRawMessages(initialRaw, state);
		expect(initialSnapshot.filteredMessages).toEqual([initialRaw[2]]);

		await expectPostGenerationSnapshotMutationAborts(initialSnapshot, (harness) => {
			if (!harness.sessionId) throw new Error("missing session");
			const mutatedRaw = [
				assistantToolCall({ id: "read-1", name: "bash", arguments: { command: "cat src/b.ts" } }),
				toolResult("read-1", "read ok"),
				initialRaw[2],
			];
			core.setDiligentContextRuntimeSnapshot(
				harness.sessionId,
				core.buildRuntimeSnapshotFromRawMessages(mutatedRaw, state),
			);
		});
	});

	test("aborts and writes nothing when only the filtered-to-raw mapping mutates after generation", async () => {
		const harness = createHarness();
		const rawMessages = [assistantText("duplicate visible text"), assistantText("duplicate visible text")];
		installRawSnapshot(harness, rawMessages);
		completeSimpleImpl = async () => {
			if (!harness.sessionId) throw new Error("missing session");
			core.setDiligentContextRuntimeSnapshot(harness.sessionId, {
				state: core.OFF_STATE,
				rawMessages,
				filteredMessages: rawMessages,
				filteredToRawIndices: [0, 0],
				resolvedAnchorIndex: null,
			});
			return { stopReason: "stop", content: [{ type: "text", text: "Generated checkpoint." }] };
		};

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "live visible mapping became invalid");
	});

	test("aborts and writes nothing when the active session changes after generation", async () => {
		const harness = createHarness();
		installRawSnapshot(harness, [userText("visible context")]);
		completeSimpleImpl = async () => {
			harness.setSessionId("session-2");
			return { stopReason: "stop", content: [{ type: "text", text: "Generated checkpoint." }] };
		};

		await runCommand(harness);

		expectNoContextWrites(harness);
		expectNotificationContaining(harness, "active session changed");
	});

	test("stale Pi post-await UI/session access aborts without rethrowing or writing", async () => {
		const harness = createHarness({ throwSessionWhenStale: true, throwUiWhenStale: true });
		installRawSnapshot(harness, [userText("visible context")]);
		completeSimpleImpl = async () => {
			harness.markStale();
			return { stopReason: "stop", content: [{ type: "text", text: "Generated checkpoint." }] };
		};

		await expect(runCommand(harness)).resolves.toBeUndefined();

		expectNoContextWrites(harness);
		expect(harness.statuses.some((status) => status.text === "diligent-contemplate: running")).toBe(true);

		completeSimpleImpl = async () => ({ stopReason: "stop", content: [{ type: "text", text: "Fresh run." }] });
		const nextHarness = createHarness();
		installRawSnapshot(nextHarness, [userText("fresh context after stale cleanup")]);
		await runCommand(nextHarness);
		expect(nextHarness.notifications.some((notification) => notification.text.includes("already running"))).toBe(false);
		expect(nextHarness.appendEntries.filter((entry) => entry.customType === core.DILIGENT_CONTEXT_CUSTOM_TYPE)).toHaveLength(1);
	});

	test("emits one warning when configured candidates are skipped and current model fallback is used", async () => {
		const harness = createHarness({ modelRegistry: currentFallbackRegistry() });
		installRawSnapshot(harness, [userText("visible context")]);

		await runCommand(harness);

		const fallbackWarnings = harness.notifications.filter((notification) => notification.text.includes("using current session model"));
		expect(fallbackWarnings).toHaveLength(1);
	});
});

describe("diligent-contemplate successful checkpoint write", () => {
	test("passes headers-only configured auth through to completeSimple", async () => {
		const harness = createHarness({
			modelRegistry: configuredRegistry({ auth: { headers: { "x-provider-token": "header-token" } } }),
		});
		installRawSnapshot(harness, [userText("visible context")]);

		await runCommand(harness);

		const options = completeSimpleCalls[0]?.[2] as { headers?: Record<string, string>; apiKey?: string } | undefined;
		expect(options?.headers).toEqual({ "x-provider-token": "header-token" });
		expect(options?.apiKey).toBeUndefined();
		expect(harness.appendEntries.filter((entry) => entry.customType === core.DILIGENT_CONTEXT_CUSTOM_TYPE)).toHaveLength(1);
	});

	test("appends anchored state, emits checkpoint artifacts, and rebuilds real-message runtime snapshot", async () => {
		const harness = createHarness();
		const rawMessages = [
			assistantToolCall({ id: "write-1", name: "bash", arguments: { command: "echo hi > src/contemplate.ts" } }),
			toolResult("write-1", "wrote file"),
			assistantText("Finished the implementation."),
		];
		installRawSnapshot(harness, rawMessages);
		completeSimpleImpl = async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: "## What we accomplished\nCaptured the current work." }],
		});

		await runCommand(harness, "focus on safety regressions");

		const contextWrites = harness.appendEntries.filter((entry) => entry.customType === core.DILIGENT_CONTEXT_CUSTOM_TYPE);
		expect(contextWrites).toHaveLength(1);
		const nextState = contextWrites[0].data as DiligentContextState;
		expect(nextState.enabled).toBe(true);
		expect(nextState.anchorMode).toBe("after-entry");
		expect(nextState.anchorFingerprint).toEqual(core.computePayloadFingerprint(rawMessages[2], 2));
		expect(nextState.checkpoints.contemplation?.body).toContain("Captured the current work");
		expect(nextState.checkpoints.contemplation?.provider).toBe("anthropic");
		expect(nextState.checkpoints.contemplation?.model).toBe("claude-opus-4-7");
		expect(nextState.checkpoints.contemplation?.visibleMessageCount).toBe(rawMessages.length);
		expect(nextState.checkpoints.provenance?.body).toContain("- src/contemplate.ts");

		const checkpointMessages = harness.sentMessages.filter((message) => message.customType === core.DILIGENT_CHECKPOINT_CUSTOM_TYPE);
		expect(checkpointMessages).toHaveLength(2);
		expect(JSON.stringify(checkpointMessages)).toContain("[Diligent contemplation checkpoint]");
		expect(JSON.stringify(checkpointMessages)).toContain("[Diligent provenance checkpoint]");

		const runtimeSnapshot = core.getDiligentContextRuntimeSnapshot("session-1");
		expect(runtimeSnapshot?.state).toEqual(nextState);
		expect(runtimeSnapshot?.rawMessages).toHaveLength(rawMessages.length);
		expect(JSON.stringify(runtimeSnapshot?.rawMessages)).not.toContain("Captured the current work");
		expect(JSON.stringify(runtimeSnapshot?.filteredMessages)).not.toContain("Captured the current work");

		expect(JSON.stringify(completeSimpleCalls[0])).toContain("<custom_prompt>\\nfocus on safety regressions\\n</custom_prompt>");
		expect(harness.statuses.at(-1)?.text).toBeUndefined();
		expectNotificationContaining(harness, "contemplation checkpoint saved");
	});
});
