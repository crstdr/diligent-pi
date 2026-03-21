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

function normalizePathValue(value: unknown): string | null {
	const path = getString(value)?.trim();
	if (!path) return null;
	return path;
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

function collectProvenanceFromMessage(message: EventMessage, buckets: ProvenanceBuckets): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!isObject(block) || block.type !== "toolCall") continue;
		const name = getString(block.name);
		if (!name) continue;
		const args = (block as { arguments?: unknown }).arguments;
		const normalizedName = normalizeToolName(name);
		if (normalizedName === "read") {
			const path = normalizePathValue((args as { path?: unknown } | null | undefined)?.path);
			if (path) buckets.read.add(path);
			continue;
		}
		if (normalizedName === "write") {
			const path = normalizePathValue((args as { path?: unknown } | null | undefined)?.path);
			if (path) buckets.written.add(path);
			continue;
		}
		if (normalizedName === "edit") {
			const path = normalizePathValue((args as { path?: unknown } | null | undefined)?.path);
			if (path) buckets.edited.add(path);
			continue;
		}
		if (normalizedName === "file_actions") {
			const fileArgs = isObject(args) ? args : null;
			const action = getString(fileArgs?.action);
			const path = normalizePathValue(fileArgs?.path);
			const newPath = normalizePathValue(fileArgs?.new_path);
			if (action === "delete" && path) buckets.deleted.add(path);
			if (action === "move" && path && newPath) buckets.moved.add(`${path} -> ${newPath}`);
		}
	}
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
	for (let i = 0; i < args.rawMessages.length; i++) {
		const beforeBoundary = args.anchorMode === "after-entry" ? i <= args.resolvedAnchorIndex : i < args.resolvedAnchorIndex;
		if (!beforeBoundary) continue;
		collectProvenanceFromMessage(args.rawMessages[i], buckets);
	}
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
