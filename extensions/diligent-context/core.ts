import { estimateTokens, type ExtensionContext } from "@mariozechner/pi-coding-agent";

export const DILIGENT_CONTEXT_CUSTOM_TYPE = "diligent-context-state";
export const DILIGENT_CONTEXT_STATUS_KEY = "diligent-context";
const ENTRY_PREVIEW_LIMIT = 60;
const FINGERPRINT_TEXT_LIMIT = 120;
const FINGERPRINT_MATCH_THRESHOLD = 3;

export type AnchorMode = "from-entry" | "after-entry" | "pending-here";

export type AnchorFingerprint = {
	role: string;
	textPrefix: string | null;
	toolNames: string[] | null;
	toolCount: number;
	payloadIndex: number;
};

export type DiligentContextState = {
	enabled: boolean;
	anchorMode: AnchorMode | null;
	anchorFingerprint: AnchorFingerprint | null;
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

export const OFF_STATE: DiligentContextState = {
	enabled: false,
	anchorMode: null,
	anchorFingerprint: null,
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
	const payloadIndex = typeof value.payloadIndex === "number" && Number.isFinite(value.payloadIndex) ? Math.max(0, Math.floor(value.payloadIndex)) : 0;
	if (!role) return null;
	return { role, textPrefix, toolNames, toolCount, payloadIndex };
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
	return { enabled: true, anchorMode, anchorFingerprint };
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
		payloadIndex,
	};
}

function fingerprintScore(msg: EventMessage, fingerprint: AnchorFingerprint): number {
	if ((msg.role ?? "unknown") !== fingerprint.role) return 0;
	let score = 1;
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
