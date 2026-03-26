import { estimateTokens, type ExtensionContext } from "@mariozechner/pi-coding-agent";

export const DILIGENT_CONTEXT_CUSTOM_TYPE = "diligent-context-state";
export const DILIGENT_CHECKPOINT_CUSTOM_TYPE = "diligent-context-checkpoint";
export const DILIGENT_CONTEXT_STATUS_KEY = "diligent-context";
const ENTRY_PREVIEW_LIMIT = 60;
const FINGERPRINT_TEXT_LIMIT = 120;
const FINGERPRINT_MATCH_THRESHOLD = 3;

export type AnchorMode = "from-entry" | "after-entry" | "pending-here";
export type CheckpointKind = "provenance" | "contemplation";

export type AnchorFingerprint = {
	role: string;
	textPrefix: string | null;
	toolNames: string[] | null;
	toolCount: number;
	toolResultId?: string | null;
	payloadIndex: number;
};

export type DiligentCheckpointArtifact = {
	id: string;
	kind: CheckpointKind;
	body: string;
	createdAt: string;
	provider?: string;
	model?: string;
	visibleMessageCount?: number;
};

export type DiligentContextCheckpoints = {
	provenance: DiligentCheckpointArtifact | null;
	contemplation: DiligentCheckpointArtifact | null;
};

export type DiligentContextState = {
	enabled: boolean;
	anchorMode: AnchorMode | null;
	anchorFingerprint: AnchorFingerprint | null;
	checkpoints: DiligentContextCheckpoints;
};

export type ToolCallBlock = {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: unknown;
};

export type TextBlock = {
	type: "text";
	text?: string;
};

export type ThinkingBlock = {
	type: "thinking";
	thinking?: string;
};

export type ContentBlock = ToolCallBlock | TextBlock | ThinkingBlock | { type?: string; [key: string]: unknown };

export type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export type EventMessage = {
	role?: string;
	toolCallId?: string;
	tool_call_id?: string;
	content?: ContentBlock[] | string;
	[key: string]: unknown;
};

export type PayloadDiagnostics = {
	roles: string[];
	blockTypes: string[];
	payloadToolIds: Set<string>;
};

export type DiligentContextRuntimeSnapshot = {
	state: DiligentContextState;
	rawMessages: EventMessage[] | null;
	filteredMessages: EventMessage[] | null;
	filteredToRawIndices: number[];
	resolvedAnchorIndex: number | null;
};

export type ContextMessageSourceType = "message" | "custom_message" | "branch_summary" | "compaction";

export type ContextMessageEntry = {
	id: string;
	sourceType: ContextMessageSourceType;
	message: EventMessage;
};

type DiligentContextRuntimeStore = {
	sessionId: string | null;
	snapshot: DiligentContextRuntimeSnapshot | null;
};

type ProvenanceBuckets = {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
	deleted: Set<string>;
	moved: Set<string>;
};

const DILIGENT_CONTEXT_RUNTIME_KEY = Symbol.for("pi.extensions.diligent-context.runtime.v1");

function getDiligentContextRuntimeStore(): DiligentContextRuntimeStore {
	const globalStore = globalThis as typeof globalThis & {
		[DILIGENT_CONTEXT_RUNTIME_KEY]?: DiligentContextRuntimeStore;
	};
	const existing = globalStore[DILIGENT_CONTEXT_RUNTIME_KEY];
	if (existing) return existing;
	const created: DiligentContextRuntimeStore = {
		sessionId: null,
		snapshot: null,
	};
	globalStore[DILIGENT_CONTEXT_RUNTIME_KEY] = created;
	return created;
}

export function getDiligentContextRuntimeSnapshot(sessionId: string | null | undefined): DiligentContextRuntimeSnapshot | null {
	if (!sessionId) return null;
	const store = getDiligentContextRuntimeStore();
	return store.sessionId === sessionId ? store.snapshot : null;
}

export function setDiligentContextRuntimeSnapshot(
	sessionId: string | null | undefined,
	snapshot: DiligentContextRuntimeSnapshot | null,
): void {
	const store = getDiligentContextRuntimeStore();
	if (!sessionId) {
		store.sessionId = null;
		store.snapshot = null;
		return;
	}
	store.sessionId = sessionId;
	store.snapshot = snapshot;
}

export const EMPTY_CHECKPOINTS: DiligentContextCheckpoints = {
	provenance: null,
	contemplation: null,
};

export const OFF_STATE: DiligentContextState = {
	enabled: false,
	anchorMode: null,
	anchorFingerprint: null,
	checkpoints: EMPTY_CHECKPOINTS,
};

export function createContextMessageEntry(entry: SessionEntry): ContextMessageEntry | null {
	const base = entry as {
		id?: unknown;
		type?: unknown;
		timestamp?: unknown;
		message?: unknown;
		customType?: unknown;
		content?: unknown;
		display?: unknown;
		details?: unknown;
		summary?: unknown;
		fromId?: unknown;
	};
	if (typeof base.id !== "string") return null;
	const timestamp = typeof base.timestamp === "string" ? new Date(base.timestamp).getTime() : Date.now();
	if (base.type === "message") {
		if (!base.message || typeof base.message !== "object") return null;
		return {
			id: base.id,
			sourceType: "message",
			message: base.message as EventMessage,
		};
	}
	if (base.type === "custom_message") {
		return {
			id: base.id,
			sourceType: "custom_message",
			message: {
				role: "custom",
				customType: getString(base.customType) ?? undefined,
				content: typeof base.content === "string" || Array.isArray(base.content) ? base.content : undefined,
				display: typeof base.display === "boolean" ? base.display : undefined,
				details: base.details,
				timestamp,
			},
		};
	}
	if (base.type === "branch_summary") {
		if (typeof base.summary !== "string") return null;
		return {
			id: base.id,
			sourceType: "branch_summary",
			message: {
				role: "branchSummary",
				summary: base.summary,
				fromId: getString(base.fromId) ?? undefined,
				timestamp,
			},
		};
	}
	return null;
}

export function buildContextMessageEntries(branchEntries: SessionEntry[]): ContextMessageEntry[] {
	const entries: ContextMessageEntry[] = [];
	let latestCompactionIndex = -1;
	let latestCompactionEntry: {
		id?: unknown;
		firstKeptEntryId?: unknown;
		summary?: unknown;
		tokensBefore?: unknown;
		timestamp?: unknown;
		type?: unknown;
	} | null = null;
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i] as {
			type?: unknown;
			id?: unknown;
			firstKeptEntryId?: unknown;
			summary?: unknown;
			tokensBefore?: unknown;
			timestamp?: unknown;
		};
		if (entry.type === "compaction") {
			latestCompactionIndex = i;
			latestCompactionEntry = entry;
		}
	}
	if (latestCompactionIndex >= 0 && latestCompactionEntry && latestCompactionEntry.type === "compaction" && typeof latestCompactionEntry.id === "string") {
		entries.push({
			id: latestCompactionEntry.id,
			sourceType: "compaction",
			message: {
				role: "compactionSummary",
				summary: typeof latestCompactionEntry.summary === "string" ? latestCompactionEntry.summary : "",
				tokensBefore: typeof latestCompactionEntry.tokensBefore === "number" ? latestCompactionEntry.tokensBefore : 0,
				timestamp: typeof latestCompactionEntry.timestamp === "string"
					? new Date(latestCompactionEntry.timestamp).getTime()
					: Date.now(),
			},
		});
		let foundFirstKept = false;
		for (let i = 0; i < latestCompactionIndex; i++) {
			const entry = branchEntries[i] as { id?: unknown };
			if (entry.id === latestCompactionEntry.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (!foundFirstKept) continue;
			const messageEntry = createContextMessageEntry(branchEntries[i]);
			if (messageEntry) entries.push(messageEntry);
		}
		for (let i = latestCompactionIndex + 1; i < branchEntries.length; i++) {
			const messageEntry = createContextMessageEntry(branchEntries[i]);
			if (messageEntry) entries.push(messageEntry);
		}
		return entries;
	}
	for (const entry of branchEntries) {
		const messageEntry = createContextMessageEntry(entry);
		if (messageEntry) entries.push(messageEntry);
	}
	return entries;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function getString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isAnchorMode(value: unknown): value is AnchorMode {
	return value === "from-entry" || value === "after-entry" || value === "pending-here";
}

function isCheckpointKind(value: unknown): value is CheckpointKind {
	return value === "provenance" || value === "contemplation";
}

export function truncate(text: string, limit: number = ENTRY_PREVIEW_LIMIT): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function estimatePayloadTokens(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce((total, item) => total + estimatePayloadTokens(item), 0);
	}
	if (isObject(value) && typeof value.role === "string") {
		return estimateTokens(value as never);
	}
	if (typeof value === "string") {
		return Math.ceil(value.length / 4);
	}
	return 0;
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `~${tokens} tokens`;
	return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

export function getTextBlocks(content: string | ContentBlock[] | undefined): string[] {
	if (typeof content === "string") {
		const text = truncate(content);
		return text ? [text] : [];
	}
	if (!Array.isArray(content)) return [];
	return content
		.filter((block): block is TextBlock => isObject(block) && block.type === "text")
		.map((block) => truncate(String(block.text ?? ""), FINGERPRINT_TEXT_LIMIT))
		.filter(Boolean);
}

export function getToolCallNames(content: string | ContentBlock[] | undefined): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (!isObject(block) || block.type !== "toolCall") continue;
		const name = getString(block.name);
		if (name) names.push(name);
	}
	return names;
}

export function getThinkingBlocks(content: string | ContentBlock[] | undefined): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		if (block.type === "thinking") {
			const text = truncate(String((block as ThinkingBlock).thinking ?? ""), FINGERPRINT_TEXT_LIMIT);
			if (text) out.push(text);
			continue;
		}
		if (block.type === "redacted_thinking") out.push("[redacted thinking]");
	}
	return out;
}

function getComparableText(msg: EventMessage): string | null {
	const summary = getString((msg as { summary?: unknown }).summary);
	if (summary) return truncate(summary, FINGERPRINT_TEXT_LIMIT);
	return getTextBlocks(msg.content)[0] ?? getThinkingBlocks(msg.content)[0] ?? null;
}

function getComparableCustomType(msg: EventMessage): string | null {
	return getString((msg as { customType?: unknown }).customType);
}

function getComparableToolNames(msg: EventMessage): string[] | null {
	const names = getToolCallNames(msg.content);
	return names.length > 0 ? [...names].sort() : null;
}

function sameStringArray(a: string[] | null, b: string[] | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

export type ContextAlignmentField = "role" | "customType" | "toolResultId" | "text" | "toolNames";

export type ContextAlignmentComparable = {
	role: string | null;
	customType: string | null;
	toolResultId: string | null;
	text: string | null;
	toolNames: string[] | null;
};

export function getContextAlignmentComparable(message: EventMessage): ContextAlignmentComparable {
	return {
		role: getString(message.role),
		customType: getComparableCustomType(message),
		toolResultId: getToolResultId(message),
		text: getComparableText(message),
		toolNames: getComparableToolNames(message),
	};
}

export function getContextAlignmentMismatchFields(expected: EventMessage, actual: EventMessage): ContextAlignmentField[] {
	const expectedComparable = getContextAlignmentComparable(expected);
	const actualComparable = getContextAlignmentComparable(actual);
	const mismatches: ContextAlignmentField[] = [];
	if (!expectedComparable.role || expectedComparable.role !== actualComparable.role) mismatches.push("role");
	if (
		(expectedComparable.customType !== null || actualComparable.customType !== null) &&
		expectedComparable.customType !== actualComparable.customType
	) {
		mismatches.push("customType");
	}
	if (
		(expectedComparable.toolResultId !== null || actualComparable.toolResultId !== null) &&
		expectedComparable.toolResultId !== actualComparable.toolResultId
	) {
		mismatches.push("toolResultId");
	}
	if ((expectedComparable.text !== null || actualComparable.text !== null) && expectedComparable.text !== actualComparable.text) {
		mismatches.push("text");
	}
	if (
		(expectedComparable.toolNames !== null || actualComparable.toolNames !== null) &&
		!sameStringArray(expectedComparable.toolNames, actualComparable.toolNames)
	) {
		mismatches.push("toolNames");
	}
	return mismatches;
}

function stableJsonStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`);
	return `{${entries.join(",")}}`;
}

function normalizeContentForContextAlignment(content: EventMessage["content"]): unknown {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content.map((block) => {
		if (!isObject(block)) return block ?? null;
		const type = getString(block.type) ?? null;
		if (type === "text") {
			return { type, text: String((block as TextBlock).text ?? "") };
		}
		if (type === "thinking") {
			return { type, thinking: String((block as ThinkingBlock).thinking ?? "") };
		}
		if (type === "redacted_thinking") {
			return { type };
		}
		if (type === "toolCall") {
			return {
				type,
				ids: getToolCallBlockIds(block),
				name: getString((block as { name?: unknown }).name),
				arguments: (block as { arguments?: unknown }).arguments ?? null,
			};
		}
		return Object.fromEntries(Object.entries(block).sort(([a], [b]) => a.localeCompare(b)));
	});
}

function getExactContextAlignmentSignature(message: EventMessage): string {
	return stableJsonStringify({
		role: getString(message.role),
		customType: getComparableCustomType(message),
		toolResultId: getToolResultId(message),
		summary: getString((message as { summary?: unknown }).summary),
		content: normalizeContentForContextAlignment(message.content),
	});
}

export function messagesMatchForContextAlignment(expected: EventMessage, actual: EventMessage): boolean {
	return getExactContextAlignmentSignature(expected) === getExactContextAlignmentSignature(actual);
}

export function getToolCallBlockIds(block: ContentBlock): string[] {
	if (!isObject(block) || block.type !== "toolCall") return [];
	return [
		getString(block.id),
		getString((block as { toolCallId?: unknown }).toolCallId),
		getString((block as { tool_call_id?: unknown }).tool_call_id),
		getString((block as { tool_use_id?: unknown }).tool_use_id),
	].filter((id): id is string => Boolean(id));
}

export function getToolIdsFromAssistantMessage(msg: EventMessage): string[] {
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
	const ids: string[] = [];
	for (const block of msg.content) {
		for (const id of getToolCallBlockIds(block)) ids.push(id);
	}
	return ids;
}

export function getToolResultId(msg: EventMessage): string | null {
	return getString(msg.toolCallId) ?? getString(msg.tool_call_id) ?? getString((msg as { tool_use_id?: unknown }).tool_use_id);
}

export function countToolCalls(content: string | ContentBlock[] | undefined): number {
	return getToolCallNames(content).length;
}

export function hasThinkingBlock(content: string | ContentBlock[] | undefined): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => isObject(block) && (block.type === "thinking" || block.type === "redacted_thinking"));
}

function hasThinkingOrRedactedThinking(content: ContentBlock[]): boolean {
	return content.some((block) => isObject(block) && (block.type === "thinking" || block.type === "redacted_thinking"));
}

export function isToolHeavyMessage(msg: EventMessage): boolean {
	if (msg.role !== "assistant") return false;
	return countToolCalls(msg.content) > 0 && getTextBlocks(msg.content).length === 0;
}

export function getProtectedPruneContext(messages: EventMessage[]): {
	protectedAssistantIdx: number;
	protectedIds: Set<string>;
} {
	let protectedAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content) && hasThinkingOrRedactedThinking(msg.content as ContentBlock[])) {
			protectedAssistantIdx = i;
			break;
		}
	}
	const protectedIds = new Set<string>();
	if (protectedAssistantIdx >= 0) {
		for (const id of getToolIdsFromAssistantMessage(messages[protectedAssistantIdx])) protectedIds.add(id);
	}
	return { protectedAssistantIdx, protectedIds };
}

export function applyPruningAtBoundary(
	messages: EventMessage[],
	resolvedAnchorIndex: number,
	anchorMode: AnchorMode,
): {
	filteredMessages: EventMessage[];
	keptRawIndices: number[];
	changed: boolean;
	reclaimedTokens: number;
	payloadPruneIds: Set<string>;
	protectedIds: Set<string>;
	protectedAssistantIdx: number;
} {
	const payloadPruneIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const beforeBoundary = anchorMode === "after-entry" ? i <= resolvedAnchorIndex : i < resolvedAnchorIndex;
		if (!beforeBoundary) continue;
		for (const id of getToolIdsFromAssistantMessage(messages[i])) payloadPruneIds.add(id);
	}

	const { protectedAssistantIdx, protectedIds } = getProtectedPruneContext(messages);
	let changed = false;
	const filteredMessages: EventMessage[] = [];
	const keptRawIndices: number[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			const id = getToolResultId(msg);
			if (id && payloadPruneIds.has(id) && !protectedIds.has(id)) {
				changed = true;
				continue;
			}
			filteredMessages.push(msg);
			keptRawIndices.push(i);
			continue;
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			if (i === protectedAssistantIdx && hasThinkingOrRedactedThinking(msg.content as ContentBlock[])) {
				filteredMessages.push(msg);
				keptRawIndices.push(i);
				continue;
			}

			const nextContent = msg.content.filter((block) => {
				if (!isObject(block) || block.type !== "toolCall") return true;
				const ids = getToolCallBlockIds(block);
				if (ids.length === 0) return true;
				return ids.some((id) => !payloadPruneIds.has(id) || protectedIds.has(id));
			});

			if (nextContent.length !== msg.content.length) changed = true;
			if (nextContent.length === 0) {
				changed = true;
				continue;
			}
			filteredMessages.push(nextContent.length === msg.content.length ? msg : { ...msg, content: nextContent });
			keptRawIndices.push(i);
			continue;
		}

		filteredMessages.push(msg);
		keptRawIndices.push(i);
	}

	return {
		filteredMessages,
		keptRawIndices,
		changed,
		reclaimedTokens: Math.max(0, estimatePayloadTokens(messages) - estimatePayloadTokens(filteredMessages)),
		payloadPruneIds,
		protectedIds,
		protectedAssistantIdx,
	};
}

export function collectPayloadDiagnostics(messages: EventMessage[]): PayloadDiagnostics {
	const roles = new Set<string>();
	const blockTypes = new Set<string>();
	const payloadToolIds = new Set<string>();
	for (const msg of messages) {
		if (typeof msg.role === "string") roles.add(msg.role);
		for (const id of [getString(msg.toolCallId), getString(msg.tool_call_id), getString((msg as { tool_use_id?: unknown }).tool_use_id)]) {
			if (id) payloadToolIds.add(id);
		}
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (!isObject(block)) continue;
			const type = getString(block.type);
			if (type) blockTypes.add(type);
			for (const id of getToolCallBlockIds(block)) payloadToolIds.add(id);
		}
	}
	return { roles: [...roles], blockTypes: [...blockTypes], payloadToolIds };
}

function normalizeFingerprint(value: unknown): AnchorFingerprint | null {
	if (!isObject(value)) return null;
	const role = getString(value.role);
	const textPrefix = value.textPrefix === null ? null : getString(value.textPrefix);
	const toolNamesRaw = value.toolNames;
	const toolNames = toolNamesRaw === null ? null : Array.isArray(toolNamesRaw)
		? toolNamesRaw.map(getString).filter((v): v is string => Boolean(v)).sort()
		: null;
	const toolCount = typeof value.toolCount === "number" && Number.isFinite(value.toolCount) ? value.toolCount : 0;
	const toolResultId = value.toolResultId === null ? null : getString(value.toolResultId);
	const payloadIndex = typeof value.payloadIndex === "number" && Number.isFinite(value.payloadIndex) ? Math.max(0, Math.floor(value.payloadIndex)) : 0;
	if (!role) return null;
	return { role, textPrefix, toolNames, toolCount, toolResultId, payloadIndex };
}

function createCheckpointId(kind: CheckpointKind): string {
	return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCheckpoint(kind: CheckpointKind, value: unknown): DiligentCheckpointArtifact | null {
	if (!isObject(value)) return null;
	if (value.kind !== kind || !isCheckpointKind(value.kind)) return null;
	const body = getString(value.body)?.trim();
	const createdAt = getString(value.createdAt);
	const id = getString(value.id);
	if (!body || !createdAt || !id) return null;
	const checkpoint: DiligentCheckpointArtifact = {
		id,
		kind,
		body,
		createdAt,
	};
	const provider = getString(value.provider);
	const model = getString(value.model);
	if (provider) checkpoint.provider = provider;
	if (model) checkpoint.model = model;
	if (typeof value.visibleMessageCount === "number" && Number.isFinite(value.visibleMessageCount)) {
		checkpoint.visibleMessageCount = Math.max(0, Math.floor(value.visibleMessageCount));
	}
	return checkpoint;
}

function normalizeCheckpoints(value: unknown, anchorMode: AnchorMode | null): DiligentContextCheckpoints {
	if (anchorMode === "pending-here") return EMPTY_CHECKPOINTS;
	if (!isObject(value)) return EMPTY_CHECKPOINTS;
	return {
		provenance: normalizeCheckpoint("provenance", value.provenance),
		contemplation: normalizeCheckpoint("contemplation", value.contemplation),
	};
}

export function cloneContent(content: EventMessage["content"]): EventMessage["content"] {
	if (!Array.isArray(content)) return content;
	return content.map((block) => ({ ...block }));
}

export function cloneEventMessage(message: EventMessage): EventMessage {
	return {
		...message,
		content: cloneContent(message.content),
	};
}

export function cloneEventMessages(messages: EventMessage[] | null | undefined): EventMessage[] | null {
	if (!messages) return null;
	return messages.map(cloneEventMessage);
}

export function buildCheckpointArtifact(args: {
	kind: CheckpointKind;
	body: string;
	provider?: string;
	model?: string;
	visibleMessageCount?: number;
	createdAt?: string;
	id?: string;
}): DiligentCheckpointArtifact {
	const body = args.body.trim();
	if (body.length === 0) {
		throw new Error(`diligent checkpoint body cannot be empty (${args.kind})`);
	}
	const checkpoint: DiligentCheckpointArtifact = {
		id: args.id ?? createCheckpointId(args.kind),
		kind: args.kind,
		body,
		createdAt: args.createdAt ?? new Date().toISOString(),
	};
	if (args.provider) checkpoint.provider = args.provider;
	if (args.model) checkpoint.model = args.model;
	if (typeof args.visibleMessageCount === "number" && Number.isFinite(args.visibleMessageCount)) {
		checkpoint.visibleMessageCount = Math.max(0, Math.floor(args.visibleMessageCount));
	}
	return checkpoint;
}

export function hasActiveCheckpoints(state: DiligentContextState): boolean {
	return state.checkpoints.contemplation !== null || state.checkpoints.provenance !== null;
}

export function getActiveCheckpoints(state: DiligentContextState): DiligentCheckpointArtifact[] {
	const checkpoints: DiligentCheckpointArtifact[] = [];
	if (state.checkpoints.contemplation) checkpoints.push(state.checkpoints.contemplation);
	if (state.checkpoints.provenance) checkpoints.push(state.checkpoints.provenance);
	return checkpoints;
}

export function withCheckpoint(
	state: DiligentContextState,
	checkpoint: DiligentCheckpointArtifact | null,
): DiligentContextState {
	if (!checkpoint) return state;
	return {
		...state,
		checkpoints: {
			...state.checkpoints,
			[checkpoint.kind]: checkpoint,
		},
	};
}

export function clearCheckpointKinds(
	state: DiligentContextState,
	kinds: CheckpointKind[] = ["provenance", "contemplation"],
): DiligentContextState {
	const nextCheckpoints: DiligentContextCheckpoints = {
		...state.checkpoints,
	};
	for (const kind of kinds) {
		nextCheckpoints[kind] = null;
	}
	return {
		...state,
		checkpoints: nextCheckpoints,
	};
}

export function buildAnchoredState(args: {
	anchorMode: Extract<AnchorMode, "from-entry" | "after-entry">;
	anchorFingerprint: AnchorFingerprint;
	checkpoints?: Partial<DiligentContextCheckpoints>;
}): DiligentContextState {
	return {
		enabled: true,
		anchorMode: args.anchorMode,
		anchorFingerprint: args.anchorFingerprint,
		checkpoints: {
			provenance: args.checkpoints?.provenance ?? null,
			contemplation: args.checkpoints?.contemplation ?? null,
		},
	};
}

function normalizeToolName(name: string): string {
	const parts = name.split(".");
	return parts[parts.length - 1] ?? name;
}

type FileTouchOperation = "read" | "write" | "edit" | "delete";

type FileTrackingAction =
	| { kind: "touch"; path: string; operation: FileTouchOperation }
	| { kind: "move"; from: string; to: string };

function normalizePathSeparators(value: string): string {
	return value.replace(/\\/g, "/");
}

function normalizeSegments(value: string, allowAboveRoot: boolean = true): string {
	const normalized = normalizePathSeparators(value);
	const segments: string[] = [];
	for (const segment of normalized.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") {
				segments.pop();
				continue;
			}
			if (!allowAboveRoot) continue;
		}
		segments.push(segment);
	}
	return segments.join("/");
}

function normalizeRelativePath(value: string): string {
	return normalizeSegments(value.trim());
}

function normalizeAbsolutePath(value: string): string {
	const normalized = normalizePathSeparators(value.trim());
	const windowsMatch = normalized.match(/^([A-Za-z]:)(?:\/(.*))?$/);
	if (windowsMatch) {
		const segments = normalizeSegments(windowsMatch[2] ?? "", false);
		return segments ? `${windowsMatch[1]}/${segments}` : `${windowsMatch[1]}/`;
	}
	const segments = normalizeSegments(normalized, false);
	return segments ? `/${segments}` : "/";
}

function isAbsolutePath(value: string): boolean {
	const normalized = normalizePathSeparators(value.trim());
	return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

function stripReadSliceSuffix(value: string): string {
	return value.replace(/:(\d+)-(\d+)$/, "");
}

function parseRootPrefixedPath(value: string): { root: string; relativePath: string } | null {
	const normalized = normalizePathSeparators(value.trim());
	if (!normalized || isAbsolutePath(normalized)) return null;
	const match = normalized.match(/^([^/:]+):(.*)$/);
	if (!match) return null;
	const relativePath = normalizeRelativePath(match[2] ?? "");
	if (!relativePath) return null;
	return { root: match[1], relativePath };
}

function normalizeTrackedPath(pathValue: string): string {
	const strippedPath = stripReadSliceSuffix(pathValue.trim());
	if (!strippedPath) return "";
	const rootPrefixed = parseRootPrefixedPath(strippedPath);
	if (rootPrefixed) return `${rootPrefixed.root}:${rootPrefixed.relativePath}`;
	if (isAbsolutePath(strippedPath)) return normalizeAbsolutePath(strippedPath);
	return normalizeRelativePath(strippedPath);
}

function resolveMoveRedirect(pathValue: string, redirects: Map<string, string>): string {
	let current = pathValue;
	const seen = new Set<string>();
	while (redirects.has(current) && !seen.has(current)) {
		seen.add(current);
		current = redirects.get(current) ?? current;
	}
	return current;
}

function createProvenanceBuckets(): ProvenanceBuckets {
	return {
		read: new Set<string>(),
		written: new Set<string>(),
		edited: new Set<string>(),
		deleted: new Set<string>(),
		moved: new Set<string>(),
	};
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isObject(block)) return "";
			return typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function commandStartsWith(cmd: string, name: string): boolean {
	const trimmed = cmd.trim();
	return trimmed === name || trimmed.startsWith(`${name} `);
}

function extractCliNamedArg(cmd: string, key: string): string | null {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = cmd.match(new RegExp(`(?:^|\\s)${escapedKey}=(?:\"([^\"]+)\"|'([^']+)'|(\\S+))`));
	return getString(match?.[1]) ?? getString(match?.[2]) ?? getString(match?.[3]) ?? null;
}

function extractJsonObject(text: string, prefix: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(prefix)) return null;
	const jsonText = trimmed.slice(prefix.length).trim();
	if (!jsonText.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(jsonText);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function extractReadPathFromCliCommand(cmd: string): string | null {
	const readFileMatch = cmd.match(/(?:^|\s)read_file\s+.*?\bpath=(?:\"([^\"]+)\"|'([^']+)'|(\S+))/);
	if (readFileMatch) {
		return stripReadSliceSuffix(getString(readFileMatch[1]) ?? getString(readFileMatch[2]) ?? getString(readFileMatch[3]) ?? "");
	}
	const simpleReadMatch = cmd.match(/^(?:read|cat)\s+(?:\"([^\"]+)\"|'([^']+)'|(\S+))/);
	if (simpleReadMatch) {
		return stripReadSliceSuffix(getString(simpleReadMatch[1]) ?? getString(simpleReadMatch[2]) ?? getString(simpleReadMatch[3]) ?? "");
	}
	return null;
}

function tokenizeShellCommand(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	const flush = () => {
		if (!current) return;
		tokens.push(current);
		current = "";
	};
	for (let index = 0; index < cmd.length; index += 1) {
		const char = cmd[index];
		const next = cmd[index + 1] ?? "";
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			flush();
			continue;
		}
		if (char === ";") {
			flush();
			tokens.push(char);
			continue;
		}
		if ((char === "&" || char === "|") && next === char) {
			flush();
			tokens.push(char + next);
			index += 1;
			continue;
		}
		if (char === "&" || char === "|") {
			flush();
			tokens.push(char);
			continue;
		}
		current += char;
	}
	flush();
	return tokens;
}

function splitShellCommands(cmd: string): string[][] {
	const commands: string[][] = [];
	let current: string[] = [];
	for (const token of tokenizeShellCommand(cmd)) {
		if (token === ";" || token === "&&" || token === "||" || token === "|" || token === "&") {
			if (current.length > 0) {
				commands.push(current);
				current = [];
			}
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) commands.push(current);
	return commands;
}

function stripShellCommandWrappers(tokens: string[]): string[] {
	let current = [...tokens];
	const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
	const wrappers = new Set(["command", "env", "noglob", "sudo"]);
	let changed = true;
	while (current.length > 0 && changed) {
		changed = false;
		while (current.length > 0 && assignmentPattern.test(current[0])) {
			current = current.slice(1);
			changed = true;
		}
		if (current.length > 0 && wrappers.has(current[0])) {
			current = current.slice(1);
			changed = true;
		}
	}
	return current;
}

function extractShellOperands(tokens: string[]): string[] {
	const operands: string[] = [];
	let allowFlags = true;
	for (const token of tokens) {
		if (allowFlags && token === "--") {
			allowFlags = false;
			continue;
		}
		if (allowFlags && token.startsWith("-")) continue;
		operands.push(token);
	}
	return operands;
}

function extractHeadTailReadOperands(tokens: string[]): string[] {
	const operands: string[] = [];
	let allowFlags = true;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (allowFlags && token === "--") {
			allowFlags = false;
			continue;
		}
		if (allowFlags) {
			if (token === "-n" || token === "-c" || token === "--lines" || token === "--bytes") {
				i += 1;
				continue;
			}
			if (token.startsWith("--lines=") || token.startsWith("--bytes=")) {
				continue;
			}
			if (token.startsWith("-")) continue;
		}
		operands.push(token);
	}
	return operands;
}

function isIgnoredRedirectTarget(value: string): boolean {
	return value === "/dev/null" || value === "/dev/stderr" || value === "/dev/stdout" || /^&\d+$/.test(value);
}

function extractRedirectWriteTargets(tokens: string[], actions: FileTrackingAction[]): void {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (/^\d*(?:>|>>|>\|)$/.test(token)) {
			if (i + 1 < tokens.length && !isIgnoredRedirectTarget(tokens[i + 1])) {
				actions.push({ kind: "touch", path: tokens[i + 1], operation: "write" });
			}
			i += 1;
			continue;
		}
		const inlineRedirect = token.match(/^\d*(>>|>\||>)(.+)$/);
		if (inlineRedirect) {
			const target = inlineRedirect[2] ?? "";
			if (!isIgnoredRedirectTarget(target)) actions.push({ kind: "touch", path: target, operation: "write" });
			continue;
		}
	}
}

function looksLikeSedExpression(value: string): boolean {
	return /^[sy]?\/.+\//.test(value) || /^\d+[,\d]*[acdipqs]?$/.test(value);
}

function stripRedirectTokens(tokens: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (/^\d*(?:>|>>|>\||<)$/.test(token)) {
			i += 1;
			continue;
		}
		if (token === "<<" || token === "<<-" || token === "<<~") {
			i += 1;
			continue;
		}
		if (/^\d*(?:>>|>\||>|<<|<)/.test(token) || token.startsWith("<<")) {
			continue;
		}
		result.push(token);
	}
	return result;
}

function stripHeredocBodies(cmd: string): string {
	const lines = cmd.split("\n");
	const result: string[] = [];
	let terminator: string | null = null;
	let justClosedHeredoc = false;
	for (const line of lines) {
		if (terminator !== null) {
			if (line.trim() === terminator) {
				terminator = null;
				justClosedHeredoc = true;
			}
			continue;
		}
		const match = line.match(/<<-?\s*(?:['"]([\w]+)['"]|([\w]+))/);
		if (match) {
			terminator = getString(match[1]) ?? getString(match[2]) ?? null;
		}
		if (justClosedHeredoc) {
			result.push("; " + line);
			justClosedHeredoc = false;
		} else {
			result.push(line);
		}
	}
	return result.join("\n");
}

function parseBashActions(cmd: string): FileTrackingAction[] {
	const actions: FileTrackingAction[] = [];
	for (const tokens of splitShellCommands(stripHeredocBodies(cmd))) {
		extractRedirectWriteTargets(tokens, actions);
		const command = stripShellCommandWrappers(stripRedirectTokens(tokens));
		if (command.length === 0) continue;
		if (command[0] === "git" && command[1] === "mv") {
			const operands = extractShellOperands(command.slice(2));
			if (operands.length === 2) actions.push({ kind: "move", from: operands[0], to: operands[1] });
			continue;
		}
		if (command[0] === "git" && command[1] === "rm") {
			for (const operand of extractShellOperands(command.slice(2))) {
				actions.push({ kind: "touch", path: operand, operation: "delete" });
			}
			continue;
		}
		if (command[0] === "mv") {
			const operands = extractShellOperands(command.slice(1));
			if (operands.length === 2) actions.push({ kind: "move", from: operands[0], to: operands[1] });
			continue;
		}
		if (command[0] === "rm" || command[0] === "trash" || command[0] === "trash-put" || command[0] === "unlink") {
			for (const operand of extractShellOperands(command.slice(1))) {
				actions.push({ kind: "touch", path: operand, operation: "delete" });
			}
			continue;
		}
		if (command[0] === "sed") {
			if (command.some((token) => /^-[a-z]*i/.test(token))) {
				const hasExplicitExpr = command.some((token) => token === "-e" || token === "-f");
				const operands = extractShellOperands(command.slice(1));
				const fileOperands = hasExplicitExpr ? operands : operands.slice(1);
				for (const operand of fileOperands) {
					if (!looksLikeSedExpression(operand)) {
						actions.push({ kind: "touch", path: operand, operation: "edit" });
					}
				}
			}
			continue;
		}
		if (command[0] === "cp" || command[0] === "rsync") {
			const operands = extractShellOperands(command.slice(1));
			if (operands.length >= 2) {
				actions.push({ kind: "touch", path: operands[operands.length - 1], operation: "write" });
			}
			continue;
		}
		if (command[0] === "tee") {
			for (const operand of extractShellOperands(command.slice(1))) {
				actions.push({ kind: "touch", path: operand, operation: "write" });
			}
			continue;
		}
		if (command[0] === "touch") {
			for (const operand of extractShellOperands(command.slice(1))) {
				actions.push({ kind: "touch", path: operand, operation: "write" });
			}
			continue;
		}
		if (command[0] === "patch") {
			const operands = extractShellOperands(command.slice(1));
			if (operands.length >= 1) actions.push({ kind: "touch", path: operands[0], operation: "edit" });
			continue;
		}
		if (command[0] === "curl") {
			for (let i = 1; i < command.length; i++) {
				if ((command[i] === "-o" || command[i] === "--output") && i + 1 < command.length) {
					actions.push({ kind: "touch", path: command[i + 1], operation: "write" });
					break;
				}
			}
			continue;
		}
		if (command[0] === "wget") {
			for (let i = 1; i < command.length; i++) {
				if ((command[i] === "-O" || command[i] === "--output-document") && i + 1 < command.length) {
					actions.push({ kind: "touch", path: command[i + 1], operation: "write" });
					break;
				}
			}
			continue;
		}
		if (command[0] === "cat") {
			for (const operand of extractShellOperands(command.slice(1))) {
				actions.push({ kind: "touch", path: operand, operation: "read" });
			}
			continue;
		}
		if (command[0] === "head" || command[0] === "tail") {
			for (const operand of extractHeadTailReadOperands(command.slice(1))) {
				actions.push({ kind: "touch", path: operand, operation: "read" });
			}
		}
	}
	return actions;
}

function parseRpExecActions(cmd: string): FileTrackingAction[] {
	const normalized = cmd.trim();
	if (!normalized) return [];
	const actions: FileTrackingAction[] = [];
	const readFileArgs = extractJsonObject(normalized, "call read_file");
	if (typeof readFileArgs?.path === "string") {
		actions.push({ kind: "touch", path: stripReadSliceSuffix(readFileArgs.path), operation: "read" });
	}
	const applyEditsArgs = extractJsonObject(normalized, "call apply_edits");
	if (typeof applyEditsArgs?.path === "string") {
		actions.push({ kind: "touch", path: applyEditsArgs.path, operation: "edit" });
	}
	const fileActionsArgs = extractJsonObject(normalized, "call file_actions");
	if (fileActionsArgs) {
		const action = getString(fileActionsArgs.action);
		const path = getString(fileActionsArgs.path);
		const newPath = getString(fileActionsArgs.new_path);
		if (action === "create" && path) actions.push({ kind: "touch", path, operation: "write" });
		if (action === "delete" && path) actions.push({ kind: "touch", path, operation: "delete" });
		if (action === "move" && path && newPath) actions.push({ kind: "move", from: path, to: newPath });
	}
	if (commandStartsWith(normalized, "apply_edits")) {
		const path = extractCliNamedArg(normalized, "path");
		if (path) actions.push({ kind: "touch", path, operation: "edit" });
	}
	if (commandStartsWith(normalized, "file_actions")) {
		const action = extractCliNamedArg(normalized, "action");
		const path = extractCliNamedArg(normalized, "path");
		const newPath = extractCliNamedArg(normalized, "new_path");
		if (action === "create" && path) actions.push({ kind: "touch", path, operation: "write" });
		if (action === "delete" && path) actions.push({ kind: "touch", path, operation: "delete" });
		if (action === "move" && path && newPath) actions.push({ kind: "move", from: path, to: newPath });
	}
	for (const command of splitShellCommands(normalized)) {
		if (command[0] !== "file") continue;
		if (command[1] === "delete") {
			for (const operand of extractShellOperands(command.slice(2))) {
				actions.push({ kind: "touch", path: operand, operation: "delete" });
			}
			continue;
		}
		if (command[1] === "move") {
			const operands = extractShellOperands(command.slice(2));
			if (operands.length === 2) actions.push({ kind: "move", from: operands[0], to: operands[1] });
		}
	}
	const readPath = extractReadPathFromCliCommand(normalized);
	if (readPath) actions.push({ kind: "touch", path: readPath, operation: "read" });
	return actions;
}

function getTrackedToolActions(name: string, args: Record<string, unknown>): FileTrackingAction[] {
	if ((name === "read" || name === "write" || name === "edit") && typeof args.path === "string") {
		return [{ kind: "touch", path: args.path, operation: name }];
	}
	if (name === "file_actions") {
		const action = getString(args.action);
		const path = getString(args.path);
		const newPath = getString(args.new_path);
		if (action === "delete" && path) return [{ kind: "touch", path, operation: "delete" }];
		if (action === "move" && path && newPath) return [{ kind: "move", from: path, to: newPath }];
		if (action === "create" && path) return [{ kind: "touch", path, operation: "write" }];
		return [];
	}
	if (name === "rp") {
		const rpCall = getString(args.call);
		const rpArgs = isObject(args.args) ? args.args : null;
		if (!rpCall || !rpArgs) return [];
		if (rpCall === "read_file" && typeof rpArgs.path === "string") {
			return [{ kind: "touch", path: rpArgs.path, operation: "read" }];
		}
		if (rpCall === "apply_edits" && typeof rpArgs.path === "string") {
			return [{ kind: "touch", path: rpArgs.path, operation: "edit" }];
		}
		if (rpCall === "file_actions") {
			const action = getString(rpArgs.action);
			if (action === "create" && typeof rpArgs.path === "string") {
				return [{ kind: "touch", path: rpArgs.path, operation: "write" }];
			}
			if (action === "delete" && typeof rpArgs.path === "string") {
				return [{ kind: "touch", path: rpArgs.path, operation: "delete" }];
			}
			if (action === "move" && typeof rpArgs.path === "string" && typeof rpArgs.new_path === "string") {
				return [{ kind: "move", from: rpArgs.path, to: rpArgs.new_path }];
			}
		}
		return [];
	}
	if (name === "rp_exec") {
		const cmd = getString(args.cmd) ?? "";
		return parseRpExecActions(cmd);
	}
	if (name === "bash") {
		const command = getString(args.command) ?? "";
		return parseBashActions(command);
	}
	return [];
}

function applyTrackedActionsToBuckets(actions: FileTrackingAction[], buckets: ProvenanceBuckets): void {
	const redirects = new Map<string, string>();
	for (const action of actions) {
		if (action.kind === "move") {
			const fromPath = normalizeTrackedPath(action.from);
			const toPath = normalizeTrackedPath(action.to);
			if (!fromPath || !toPath || fromPath === toPath) continue;
			const canonicalFrom = resolveMoveRedirect(fromPath, redirects);
			const canonicalTo = resolveMoveRedirect(toPath, redirects);
			if (!canonicalFrom || !canonicalTo || canonicalFrom === canonicalTo) continue;
			redirects.set(canonicalFrom, canonicalTo);
			if (fromPath !== canonicalFrom) redirects.set(fromPath, canonicalTo);
			buckets.moved.add(`${canonicalFrom} -> ${canonicalTo}`);
			continue;
		}
		const normalizedPath = normalizeTrackedPath(action.path);
		if (!normalizedPath) continue;
		if (action.operation !== "read") {
			redirects.delete(normalizedPath);
		}
		const canonicalPath = resolveMoveRedirect(normalizedPath, redirects);
		if (!canonicalPath) continue;
		if (action.operation === "read") buckets.read.add(canonicalPath);
		if (action.operation === "write") buckets.written.add(canonicalPath);
		if (action.operation === "edit") buckets.edited.add(canonicalPath);
		if (action.operation === "delete") buckets.deleted.add(canonicalPath);
	}
}

function collectGroundedProvenanceFromMessages(messages: EventMessage[], buckets: ProvenanceBuckets): void {
	const toolCalls = new Map<string, FileTrackingAction[]>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isObject(block) || block.type !== "toolCall") continue;
			const toolCallIds = getToolCallBlockIds(block);
			const toolName = getString(block.name);
			const args = isObject((block as { arguments?: unknown }).arguments)
				? (block as { arguments?: Record<string, unknown> }).arguments ?? {}
				: {};
			if (!toolName || toolCallIds.length === 0) continue;
			const actions = getTrackedToolActions(normalizeToolName(toolName), args);
			if (actions.length === 0) continue;
			for (const toolCallId of toolCallIds) {
				toolCalls.set(toolCallId, actions);
			}
		}
	}

	const successfulActions: FileTrackingAction[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || Boolean((message as { isError?: unknown }).isError)) continue;
		const toolCallId = getToolResultId(message);
		if (!toolCallId) continue;
		const actions = toolCalls.get(toolCallId);
		if (!actions || actions.length === 0) continue;
		const toolResultText = extractTextFromContent(message.content);
		const isNoOpEdit = /applied:\s*0|no changes applied|nothing to (?:do|change)/i.test(toolResultText);
		for (const action of actions) {
			if (action.kind === "touch" && action.operation === "edit" && isNoOpEdit) continue;
			successfulActions.push(action);
		}
	}

	applyTrackedActionsToBuckets(successfulActions, buckets);
}

function formatBucketLines(values: Set<string>): string {
	return [...values].sort().map((value) => `- ${value}`).join("\n");
}

function renderProvenanceBody(buckets: ProvenanceBuckets): string {
	const sections: string[] = [];
	const readOnly = [...buckets.read].filter((path) => !buckets.written.has(path) && !buckets.edited.has(path) && !buckets.deleted.has(path));
	if (readOnly.length > 0) {
		sections.push(`<read>\n${readOnly.sort().map((value) => `- ${value}`).join("\n")}\n</read>`);
	}
	if (buckets.edited.size > 0) {
		sections.push(`<edited>\n${formatBucketLines(buckets.edited)}\n</edited>`);
	}
	if (buckets.written.size > 0) {
		sections.push(`<written>\n${formatBucketLines(buckets.written)}\n</written>`);
	}
	if (buckets.deleted.size > 0) {
		sections.push(`<deleted>\n${formatBucketLines(buckets.deleted)}\n</deleted>`);
	}
	if (buckets.moved.size > 0) {
		sections.push(`<moved>\n${formatBucketLines(buckets.moved)}\n</moved>`);
	}
	if (sections.length === 0) return "";
	return [
		`<checkpoint v="1" kind="provenance" scope="before-boundary">`,
		"<files>",
		...sections,
		"</files>",
		"</checkpoint>",
	].join("\n");
}

export function buildProvenanceCheckpoint(args: {
	rawMessages: EventMessage[];
	resolvedAnchorIndex: number | null;
	anchorMode: AnchorMode | null;
}): DiligentCheckpointArtifact | null {
	if (!args.rawMessages.length) return null;
	if (args.resolvedAnchorIndex === null) return null;
	if (args.anchorMode !== "after-entry" && args.anchorMode !== "from-entry") return null;
	const buckets = createProvenanceBuckets();
	const hiddenPrefixMessages: EventMessage[] = [];
	const hiddenToolCallIds = new Set<string>();
	for (let i = 0; i < args.rawMessages.length; i++) {
		const beforeBoundary = args.anchorMode === "after-entry" ? i <= args.resolvedAnchorIndex : i < args.resolvedAnchorIndex;
		if (!beforeBoundary) continue;
		const message = args.rawMessages[i];
		hiddenPrefixMessages.push(message);
		for (const id of getToolIdsFromAssistantMessage(message)) hiddenToolCallIds.add(id);
	}
	if (hiddenToolCallIds.size > 0) {
		for (let i = 0; i < args.rawMessages.length; i++) {
			const beforeBoundary = args.anchorMode === "after-entry" ? i <= args.resolvedAnchorIndex : i < args.resolvedAnchorIndex;
			if (beforeBoundary) continue;
			const message = args.rawMessages[i];
			if (message.role !== "toolResult") continue;
			const toolResultId = getToolResultId(message);
			if (!toolResultId || !hiddenToolCallIds.has(toolResultId)) continue;
			hiddenPrefixMessages.push(message);
		}
	}
	collectGroundedProvenanceFromMessages(hiddenPrefixMessages, buckets);
	const body = renderProvenanceBody(buckets).trim();
	if (body.length === 0) return null;
	return buildCheckpointArtifact({ kind: "provenance", body });
}

export function buildCheckpointDisplayText(checkpoint: DiligentCheckpointArtifact): string {
	const label = checkpoint.kind === "contemplation"
		? "[Diligent contemplation checkpoint]"
		: "[Diligent provenance checkpoint]";
	return `${label}\n\n${checkpoint.body}`;
}

export function buildCheckpointSyntheticMessage(checkpoint: DiligentCheckpointArtifact): EventMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: buildCheckpointDisplayText(checkpoint) }],
	};
}

export function buildProjectedCheckpointMessages(state: DiligentContextState): EventMessage[] {
	return getActiveCheckpoints(state).map((checkpoint) => buildCheckpointSyntheticMessage(checkpoint));
}

export function getDiligentContextStateSignature(state: DiligentContextState): string {
	return stableJsonStringify(state);
}

export function computeVisibleSnapshot(args: {
	rawMessages: EventMessage[];
	state: DiligentContextState;
}): {
	filteredMessages: EventMessage[];
	keptRawIndices: number[];
	resolvedAnchorIndex: number | null;
	changed: boolean;
	reclaimedTokens: number;
} {
	const rawMessages = args.rawMessages;
	const state = args.state;
	let filteredMessages = rawMessages;
	let keptRawIndices = rawMessages.map((_, index) => index);
	let changed = false;
	let reclaimedTokens = 0;
	const resolvedAnchorIndex = state.enabled ? resolveAnchorIndex(rawMessages, state.anchorFingerprint) : null;
	if (state.enabled && resolvedAnchorIndex !== null) {
		const pruneResult = applyPruningAtBoundary(rawMessages, resolvedAnchorIndex, state.anchorMode ?? "from-entry");
		filteredMessages = pruneResult.filteredMessages;
		keptRawIndices = pruneResult.keptRawIndices;
		changed = pruneResult.changed;
		reclaimedTokens = pruneResult.reclaimedTokens;
	}
	return {
		filteredMessages,
		keptRawIndices,
		resolvedAnchorIndex,
		changed,
		reclaimedTokens,
	};
}

export function buildRuntimeSnapshotFromRawMessages(
	rawMessages: EventMessage[],
	state: DiligentContextState,
): DiligentContextRuntimeSnapshot {
	const projection = computeVisibleSnapshot({ rawMessages, state });
	const clonedRawMessages = cloneEventMessages(rawMessages) ?? [];
	const clonedFilteredMessages = cloneEventMessages(projection.filteredMessages) ?? [];
	return {
		state,
		rawMessages: clonedRawMessages,
		filteredMessages: clonedFilteredMessages,
		filteredToRawIndices: [...projection.keptRawIndices],
		resolvedAnchorIndex: projection.resolvedAnchorIndex,
	};
}

export function normalizeState(value: unknown): DiligentContextState {
	if (!isObject(value)) return OFF_STATE;
	if ("keepLast" in value || "anchorEntryId" in value) return OFF_STATE;
	const enabled = value.enabled === true;
	if (!enabled) return OFF_STATE;
	const anchorMode = value.anchorMode;
	if (!isAnchorMode(anchorMode)) return OFF_STATE;
	const anchorFingerprint = value.anchorFingerprint === null ? null : normalizeFingerprint(value.anchorFingerprint);
	if (anchorFingerprint === null && anchorMode !== "pending-here") return OFF_STATE;
	return {
		enabled: true,
		anchorMode,
		anchorFingerprint,
		checkpoints: normalizeCheckpoints(value.checkpoints, anchorMode),
	};
}

export function loadStateFromEntries(entries: SessionEntry[] | undefined): DiligentContextState {
	const last = [...(entries ?? [])]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === DILIGENT_CONTEXT_CUSTOM_TYPE);
	return normalizeState(last?.data);
}

export function loadStateFromSession(ctx: ExtensionContext): DiligentContextState {
	return loadStateFromEntries((ctx.sessionManager.getBranch() ?? []) as SessionEntry[]);
}

export function getPayloadNarrativeLabel(msg: EventMessage): string | null {
	if (msg.role === "user") {
		const text = getTextBlocks(msg.content)[0];
		return text ? `👤 ${truncate(text)}` : null;
	}
	if (msg.role === "assistant") {
		const text = getTextBlocks(msg.content)[0];
		if (text) {
			const toolCount = countToolCalls(msg.content);
			return toolCount > 0 ? `🤖 ${truncate(text)} (+${toolCount} tools)` : `🤖 ${truncate(text)}`;
		}
		if (hasThinkingBlock(msg.content)) return "🤖 [thinking]";
		return null;
	}
	if (msg.role === "compactionSummary") {
		const text = getString((msg as { summary?: unknown }).summary);
		return text ? `🗜 ${truncate(text)}` : null;
	}
	return null;
}

export function getPayloadExactLabel(msg: EventMessage): string | null {
	const narrative = getPayloadNarrativeLabel(msg);
	if (narrative) return narrative;
	if (!isToolHeavyMessage(msg)) return null;
	const toolNames = getToolCallNames(msg.content);
	if (toolNames.length > 0) return `🔧 ${truncate(toolNames.join(", "))}`;
	return "🔧 tool entry";
}

function getFingerprintText(content: string | ContentBlock[] | undefined): string | null {
	const text = getTextBlocks(content)[0] ?? null;
	if (text) return text;
	return getThinkingBlocks(content)[0] ?? null;
}

export function computePayloadFingerprint(msg: EventMessage, payloadIndex: number): AnchorFingerprint {
	const textPrefix = getFingerprintText(msg.content);
	const toolNames = getToolCallNames(msg.content);
	return {
		role: msg.role ?? "unknown",
		textPrefix,
		toolNames: toolNames.length > 0 ? [...toolNames].sort() : null,
		toolCount: toolNames.length,
		toolResultId: getToolResultId(msg),
		payloadIndex,
	};
}

function fingerprintScore(msg: EventMessage, fingerprint: AnchorFingerprint): number {
	if ((msg.role ?? "unknown") !== fingerprint.role) return 0;
	let score = 1;
	const candidateToolResultId = getToolResultId(msg);
	if (fingerprint.toolResultId && candidateToolResultId === fingerprint.toolResultId) score += 4;
	const candidateText = getFingerprintText(msg.content);
	if (fingerprint.textPrefix && candidateText === fingerprint.textPrefix) score += 3;
	const candidateNames = getToolCallNames(msg.content);
	const sortedCandidateNames = candidateNames.length > 0 ? [...candidateNames].sort() : null;
	if (fingerprint.toolNames && sortedCandidateNames && fingerprint.toolNames.length === sortedCandidateNames.length && fingerprint.toolNames.every((name, idx) => name === sortedCandidateNames[idx])) {
		score += 2;
	}
	if (fingerprint.toolCount > 0 && fingerprint.toolCount === candidateNames.length) score += 1;
	return score;
}

export function resolveAnchorIndex(messages: EventMessage[], fingerprint: AnchorFingerprint | null): number | null {
	if (!fingerprint) return null;
	let bestIndex: number | null = null;
	let bestScore = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < messages.length; i++) {
		const score = fingerprintScore(messages[i], fingerprint);
		if (score < FINGERPRINT_MATCH_THRESHOLD) continue;
		const distance = Math.abs(i - fingerprint.payloadIndex);
		if (score > bestScore || (score === bestScore && distance < bestDistance) || (score === bestScore && distance === bestDistance && (bestIndex === null || i > bestIndex))) {
			bestScore = score;
			bestDistance = distance;
			bestIndex = i;
		}
	}
	return bestIndex;
}
