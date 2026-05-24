/**
 * Pure visibility-aware compaction preparation helpers.
 *
 * This module intentionally contains no Pi UI, filesystem, pending-request,
 * model-call, or command/event orchestration side effects.
 */

import type { SessionBeforeCompactEvent } from "@mariozechner/pi-coding-agent";
import {
	buildCheckpointDisplayText,
	buildContextMessageEntries,
	buildProjectedCheckpointMessages,
	estimatePayloadTokens,
	getActiveCheckpoints,
	getContextAlignmentComparable,
	getContextAlignmentMismatchFields,
	getPayloadNarrativeLabel,
	messagesMatchForContextAlignment,
	type ContextAlignmentComparable,
	type ContextAlignmentField,
	type ContextMessageEntry,
	type DiligentContextRuntimeSnapshot,
	type DiligentContextState,
	type EventMessage,
} from "../diligent-context/core.ts";

export type CompactionRoute = "native" | "compatibility" | "opinionated" | "force-native";
export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
export type PendingCompactionMode = "opinionated" | "force-native";

export type FileOpsLike = {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
};

export type DiagnosticMessageSummary = {
	index: number;
	role: string | null;
	sourceType?: ContextMessageEntry["sourceType"];
	customType: string | null;
	toolResultId: string | null;
	text: string | null;
	toolNames: string[] | null;
};

export type AlignmentStats = {
	rawMessageCount: number;
	contextEntryCount: number;
	requiredContextEntryCount: number;
	matchedPrefixCount: number;
	skippedCustomMessageCount: number;
};

export type AlignmentDivergenceDiagnostic = {
	kind: "required-entry-mismatch" | "required-context-tail" | "unmatched-raw-tail";
	stats: AlignmentStats;
	rawIndex: number | null;
	contextIndex: number | null;
	mismatchFields?: ContextAlignmentField[];
	rawWindow: DiagnosticMessageSummary[];
	contextWindow: DiagnosticMessageSummary[];
};

export type VisiblePreparationFailureDiagnostic =
	| {
			kind: "filtered-to-raw-length-mismatch";
			filteredMessageCount: number;
			filteredToRawCount: number;
			rawMessageCount: number;
		}
	| {
			kind: "raw-context-alignment-divergence";
			alignment: AlignmentDivergenceDiagnostic;
		}
	| {
			kind: "first-kept-entry-id-missing";
			firstKeptVisibleIndex: number;
			firstKeptRawIndex: number | null;
			rawMessageCount: number;
			mappingCount: number;
		};

export type VisiblePreparationFailureReason =
	| "no-live-payload"
	| "anchor-restoring"
	| "context-mapping-mismatch"
	| "nothing-visible-to-compact";

export type VisiblePreparationBuildResult =
	| {
			ok: true;
			preparation: CompactionPreparation;
			anchorSignature: string | null;
			totalVisibleMessages: number;
			summarizedVisibleMessages: number;
			keptVisibleMessages: number;
		}
	| {
			ok: false;
			reason: VisiblePreparationFailureReason;
			message: string;
			diagnostic?: VisiblePreparationFailureDiagnostic;
		};

export type RawContextAlignmentResult =
	| {
			ok: true;
			rawIndexToEntryId: string[];
			stats: AlignmentStats;
		}
	| {
			ok: false;
			diagnostic: AlignmentDivergenceDiagnostic;
		};

export function computeCompactionRoute(args: {
	pendingMode?: PendingCompactionMode;
	diligentEnabled: boolean;
}): CompactionRoute {
	if (args.pendingMode === "force-native") return "force-native";
	if (args.pendingMode === "opinionated") return "opinionated";
	return args.diligentEnabled ? "compatibility" : "native";
}

export function isVisiblePreparationFailure(
	result: VisiblePreparationBuildResult,
): result is Extract<VisiblePreparationBuildResult, { ok: false }> {
	return result.ok === false;
}

export function createFileOps(): FileOpsLike {
	return {
		read: new Set<string>(),
		written: new Set<string>(),
		edited: new Set<string>(),
	};
}

export function extractFileOpsFromVisibleMessage(message: EventMessage, fileOps: FileOpsLike): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!block || typeof block !== "object" || block.type !== "toolCall") continue;
		const args = (block as { arguments?: unknown }).arguments;
		if (!args || typeof args !== "object") continue;
		const pathValue = (args as { path?: unknown }).path;
		if (typeof pathValue !== "string" || pathValue.length === 0) continue;
		switch ((block as { name?: unknown }).name) {
			case "read":
				fileOps.read.add(pathValue);
				break;
			case "write":
				fileOps.written.add(pathValue);
				break;
			case "edit":
				fileOps.edited.add(pathValue);
				break;
		}
	}
}

export function extractVisibleFileOps(messages: EventMessage[]): FileOpsLike {
	const fileOps = createFileOps();
	for (const message of messages) {
		extractFileOpsFromVisibleMessage(message, fileOps);
	}
	return fileOps;
}

export function isResolvedDiligentSnapshot(snapshot: DiligentContextRuntimeSnapshot | null): boolean {
	return Boolean(
		snapshot &&
			snapshot.state.enabled &&
			snapshot.state.anchorMode !== "pending-here" &&
			snapshot.resolvedAnchorIndex !== null,
	);
}

export function buildCheckpointPreviousSummary(state: DiligentContextState): string | undefined {
	const checkpoints = getActiveCheckpoints(state);
	if (checkpoints.length === 0) return undefined;
	return checkpoints.map((checkpoint) => buildCheckpointDisplayText(checkpoint)).join("\n\n");
}

export function getCurrentAnchorSignature(snapshot: DiligentContextRuntimeSnapshot | null): string | null {
	if (!snapshot || !snapshot.state.enabled || snapshot.state.anchorMode === "pending-here" || snapshot.resolvedAnchorIndex === null || !snapshot.state.anchorFingerprint) {
		return null;
	}
	return JSON.stringify({
		anchorMode: snapshot.state.anchorMode,
		anchorFingerprint: snapshot.state.anchorFingerprint,
	});
}

export function buildAlignmentStats(
	rawMessages: EventMessage[],
	contextEntries: ContextMessageEntry[],
	matchedPrefixCount: number,
	skippedCustomMessageCount: number,
): AlignmentStats {
	return {
		rawMessageCount: rawMessages.length,
		contextEntryCount: contextEntries.length,
		requiredContextEntryCount: contextEntries.filter((entry) => entry.sourceType !== "custom_message").length,
		matchedPrefixCount,
		skippedCustomMessageCount,
	};
}

export function summarizeComparableMessage(
	index: number,
	comparable: ContextAlignmentComparable,
	sourceType?: ContextMessageEntry["sourceType"],
): DiagnosticMessageSummary {
	return {
		index,
		role: comparable.role,
		sourceType,
		customType: comparable.customType,
		toolResultId: comparable.toolResultId,
		text: comparable.text,
		toolNames: comparable.toolNames ? [...comparable.toolNames] : null,
	};
}

export function summarizeRawMessage(message: EventMessage, index: number): DiagnosticMessageSummary {
	return summarizeComparableMessage(index, getContextAlignmentComparable(message));
}

export function summarizeContextEntry(entry: ContextMessageEntry, index: number): DiagnosticMessageSummary {
	return summarizeComparableMessage(index, getContextAlignmentComparable(entry.message), entry.sourceType);
}

export function buildRawWindow(rawMessages: EventMessage[], center: number | null): DiagnosticMessageSummary[] {
	if (rawMessages.length === 0) return [];
	const normalizedCenter = center === null ? rawMessages.length - 1 : Math.max(0, Math.min(center, rawMessages.length - 1));
	const start = Math.max(0, normalizedCenter - 1);
	const end = Math.min(rawMessages.length, normalizedCenter + 3);
	const out: DiagnosticMessageSummary[] = [];
	for (let i = start; i < end; i++) out.push(summarizeRawMessage(rawMessages[i], i));
	return out;
}

export function buildContextWindow(contextEntries: ContextMessageEntry[], center: number | null): DiagnosticMessageSummary[] {
	if (contextEntries.length === 0) return [];
	const normalizedCenter = center === null ? contextEntries.length - 1 : Math.max(0, Math.min(center, contextEntries.length - 1));
	const start = Math.max(0, normalizedCenter - 1);
	const end = Math.min(contextEntries.length, normalizedCenter + 3);
	const out: DiagnosticMessageSummary[] = [];
	for (let i = start; i < end; i++) out.push(summarizeContextEntry(contextEntries[i], i));
	return out;
}

export function buildAlignmentDivergenceDiagnostic(args: {
	kind: AlignmentDivergenceDiagnostic["kind"];
	rawMessages: EventMessage[];
	contextEntries: ContextMessageEntry[];
	matchedPrefixCount: number;
	skippedCustomMessageCount: number;
	rawIndex: number | null;
	contextIndex: number | null;
	mismatchFields?: ContextAlignmentField[];
}): AlignmentDivergenceDiagnostic {
	return {
		kind: args.kind,
		stats: buildAlignmentStats(args.rawMessages, args.contextEntries, args.matchedPrefixCount, args.skippedCustomMessageCount),
		rawIndex: args.rawIndex,
		contextIndex: args.contextIndex,
		mismatchFields: args.mismatchFields,
		rawWindow: buildRawWindow(args.rawMessages, args.rawIndex),
		contextWindow: buildContextWindow(args.contextEntries, args.contextIndex),
	};
}

export function alignRawMessagesToContextEntries(
	rawMessages: EventMessage[],
	contextEntries: ContextMessageEntry[],
): RawContextAlignmentResult {
	const rawIndexToEntryId: string[] = [];
	let rawIndex = 0;
	let skippedCustomMessageCount = 0;
	for (let contextIndex = 0; contextIndex < contextEntries.length; contextIndex++) {
		const contextEntry = contextEntries[contextIndex];
		if (rawIndex >= rawMessages.length) {
			if (contextEntry.sourceType === "custom_message") {
				skippedCustomMessageCount += 1;
				continue;
			}
			return {
				ok: false,
				diagnostic: buildAlignmentDivergenceDiagnostic({
					kind: "required-context-tail",
					rawMessages,
					contextEntries,
					matchedPrefixCount: rawIndexToEntryId.length,
					skippedCustomMessageCount,
					rawIndex,
					contextIndex,
				}),
			};
		}
		if (messagesMatchForContextAlignment(contextEntry.message, rawMessages[rawIndex])) {
			rawIndexToEntryId.push(contextEntry.id);
			rawIndex += 1;
			continue;
		}
		if (contextEntry.sourceType === "custom_message") {
			skippedCustomMessageCount += 1;
			continue;
		}
		return {
			ok: false,
			diagnostic: buildAlignmentDivergenceDiagnostic({
				kind: "required-entry-mismatch",
				rawMessages,
				contextEntries,
				matchedPrefixCount: rawIndexToEntryId.length,
				skippedCustomMessageCount,
				rawIndex,
				contextIndex,
				mismatchFields: getContextAlignmentMismatchFields(contextEntry.message, rawMessages[rawIndex]),
			}),
		};
	}
	if (rawIndex !== rawMessages.length || rawIndexToEntryId.length !== rawMessages.length) {
		return {
			ok: false,
			diagnostic: buildAlignmentDivergenceDiagnostic({
				kind: "unmatched-raw-tail",
				rawMessages,
				contextEntries,
				matchedPrefixCount: rawIndexToEntryId.length,
				skippedCustomMessageCount,
				rawIndex,
				contextIndex: contextEntries.length,
			}),
		};
	}
	return {
		ok: true,
		rawIndexToEntryId,
		stats: buildAlignmentStats(rawMessages, contextEntries, rawIndexToEntryId.length, skippedCustomMessageCount),
	};
}

export function findPreferredVisibleCutIndex(messages: EventMessage[], minIndex: number): number {
	for (let i = minIndex; i < messages.length; i++) {
		if (getPayloadNarrativeLabel(messages[i]) !== null) return i;
	}
	return Math.min(minIndex, messages.length - 1);
}

export function computeFirstKeptVisibleIndex(messages: EventMessage[], keepRecentTokens: number): number {
	if (messages.length <= 1) return 0;
	if (!Number.isFinite(keepRecentTokens) || keepRecentTokens <= 0) return 1;
	let accumulatedTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const messageTokens = estimatePayloadTokens(messages[i]);
		if (accumulatedTokens + messageTokens > keepRecentTokens) {
			if (i >= messages.length - 1) return messages.length - 1;
			return findPreferredVisibleCutIndex(messages, i + 1);
		}
		accumulatedTokens += messageTokens;
	}
	return 0;
}

export function buildVisiblePreparation(
	snapshot: DiligentContextRuntimeSnapshot | null,
	diligentState: DiligentContextState,
	preparation: CompactionPreparation,
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
): VisiblePreparationBuildResult {
	if (!snapshot?.filteredMessages || snapshot.filteredMessages.length === 0) {
		return {
			ok: false,
			reason: "no-live-payload",
			message: "no live visible context available yet — send a message first",
		};
	}
	if (diligentState.enabled && !isResolvedDiligentSnapshot(snapshot)) {
		const anchorLost = snapshot.state.anchorMode !== "pending-here" && (snapshot.rawMessages?.length ?? 0) > 0;
		return {
			ok: false,
			reason: "anchor-restoring",
			message: anchorLost
				? "the current diligent-context anchor was lost from live payload — send another message or run /diligent-context here to re-anchor"
				: "the current diligent-context boundary is still restoring — send a message first",
		};
	}
	if (!snapshot.rawMessages || snapshot.filteredToRawIndices.length !== snapshot.filteredMessages.length) {
		return {
			ok: false,
			reason: "context-mapping-mismatch",
			message: "the current live context could not be mapped back to session entries safely",
			diagnostic: {
				kind: "filtered-to-raw-length-mismatch",
				filteredMessageCount: snapshot.filteredMessages.length,
				filteredToRawCount: snapshot.filteredToRawIndices.length,
				rawMessageCount: snapshot.rawMessages?.length ?? 0,
			},
		};
	}
	const contextEntries = buildContextMessageEntries(branchEntries);
	const alignment = alignRawMessagesToContextEntries(snapshot.rawMessages, contextEntries);
	if (!alignment.ok) {
		return {
			ok: false,
			reason: "context-mapping-mismatch",
			message: "the current live context no longer matches the session state safely",
			diagnostic: {
				kind: "raw-context-alignment-divergence",
				alignment: alignment.diagnostic,
			},
		};
	}
	const rawIndexToEntryId = alignment.rawIndexToEntryId;
	const keepRecentTokens = typeof preparation.settings?.keepRecentTokens === "number" && Number.isFinite(preparation.settings.keepRecentTokens)
		? Math.max(0, Math.floor(preparation.settings.keepRecentTokens))
		: 0;
	const firstKeptVisibleIndex = computeFirstKeptVisibleIndex(snapshot.filteredMessages, keepRecentTokens);
	if (firstKeptVisibleIndex <= 0) {
		return {
			ok: false,
			reason: "nothing-visible-to-compact",
			message: "nothing visible to compact yet within the current live context",
		};
	}
	const firstKeptRawIndex = snapshot.filteredToRawIndices[firstKeptVisibleIndex];
	const firstKeptEntryId = typeof firstKeptRawIndex === "number" ? rawIndexToEntryId[firstKeptRawIndex] : undefined;
	if (typeof firstKeptEntryId !== "string" || firstKeptEntryId.length === 0) {
		return {
			ok: false,
			reason: "context-mapping-mismatch",
			message: "the visible compaction boundary could not be mapped back to session entries safely",
			diagnostic: {
				kind: "first-kept-entry-id-missing",
				firstKeptVisibleIndex,
				firstKeptRawIndex: typeof firstKeptRawIndex === "number" ? firstKeptRawIndex : null,
				rawMessageCount: snapshot.rawMessages.length,
				mappingCount: rawIndexToEntryId.length,
			},
		};
	}
	const messagesToSummarize = snapshot.filteredMessages.slice(0, firstKeptVisibleIndex);
	const totalVisibleMessages = snapshot.filteredMessages.length;
	const summarizedVisibleMessages = messagesToSummarize.length;
	const keptVisibleMessages = totalVisibleMessages - summarizedVisibleMessages;
	const projectedCheckpointMessages = buildProjectedCheckpointMessages(diligentState);
	const previousSummary = buildCheckpointPreviousSummary(diligentState);
	return {
		ok: true,
		preparation: {
			...preparation,
			firstKeptEntryId,
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			previousSummary,
			tokensBefore: estimatePayloadTokens(snapshot.filteredMessages) + estimatePayloadTokens(projectedCheckpointMessages),
			fileOps: extractVisibleFileOps(messagesToSummarize) as CompactionPreparation["fileOps"],
		},
		anchorSignature: getCurrentAnchorSignature(snapshot),
		totalVisibleMessages,
		summarizedVisibleMessages,
		keptVisibleMessages,
	};
}
