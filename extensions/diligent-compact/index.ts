/**
 * Diligent Compact Extension
 *
 * Routes compaction through one of three modes:
 * - native: let Pi's built-in /compact run unchanged
 * - compatibility: run Pi's native compaction helper on only the diligent-visible slice
 * - opinionated: run our custom model/prompt compactor on the diligent-visible slice
 */

import {
	CompactionSummaryMessageComponent,
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import {
	buildCheckpointDisplayText,
	buildContextMessageEntries,
	buildProjectedCheckpointMessages,
	buildRuntimeSnapshotFromRawMessages,
	getActiveCheckpoints,
	getContextAlignmentComparable,
	getContextAlignmentMismatchFields,
	getDiligentContextRuntimeSnapshot,
	getDiligentContextStateSignature,
	setDiligentContextRuntimeSnapshot,
	estimatePayloadTokens,
	formatTokens,
	getPayloadNarrativeLabel,
	loadStateFromEntries,
	messagesMatchForContextAlignment,
	type ContextAlignmentComparable,
	type ContextAlignmentField,
	type ContextMessageEntry,
	type DiligentContextRuntimeSnapshot,
	type DiligentContextState,
	type EventMessage,
	type SessionEntry,
} from "../diligent-context/core.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildTaggedPromptText,
	CONFIG,
	debugLog,
	readOptionalTextFile,
	runCompatibilityCompactionRequest,
	runOpinionatedCompactionRequest,
	type ThinkingLevel,
} from "./shared.ts";

type CompactionRoute = "native" | "compatibility" | "opinionated" | "force-native";
type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type PendingCompactionRequest = {
	expiresAt: number;
	nonce: number;
	mode: "opinionated" | "force-native";
	fallbackThinkingLevel: ThinkingLevel;
};

type DiligentCompactionDetails = {
	diligentContextAnchorSignature?: string;
	route?: Exclude<CompactionRoute, "native" | "force-native">;
	[key: string]: unknown;
};

type FileOpsLike = {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
};

type DiagnosticMessageSummary = {
	index: number;
	role: string | null;
	sourceType?: ContextMessageEntry["sourceType"];
	customType: string | null;
	toolResultId: string | null;
	text: string | null;
	toolNames: string[] | null;
};

type AlignmentStats = {
	rawMessageCount: number;
	contextEntryCount: number;
	requiredContextEntryCount: number;
	matchedPrefixCount: number;
	skippedCustomMessageCount: number;
};

type AlignmentDivergenceDiagnostic = {
	kind: "required-entry-mismatch" | "required-context-tail" | "unmatched-raw-tail";
	stats: AlignmentStats;
	rawIndex: number | null;
	contextIndex: number | null;
	mismatchFields?: ContextAlignmentField[];
	rawWindow: DiagnosticMessageSummary[];
	contextWindow: DiagnosticMessageSummary[];
};

type VisiblePreparationFailureDiagnostic =
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

type VisiblePreparationBuildResult =
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
			reason:
				| "no-live-payload"
				| "anchor-restoring"
				| "context-mapping-mismatch"
				| "nothing-visible-to-compact";
			message: string;
			diagnostic?: VisiblePreparationFailureDiagnostic;
		};

function isVisiblePreparationFailure(
	result: VisiblePreparationBuildResult,
): result is Extract<VisiblePreparationBuildResult, { ok: false }> {
	return result.ok === false;
}

const OPINIONATED_REQUEST_TTL_MS = 10_000;
const COMPACTION_STATUS_KEY = "diligent-compact";
const COMPACTION_SUMMARY_WIDGET_KEY = "diligent-compact-summary";

const pendingCompactionRequests = new Map<string, PendingCompactionRequest>();
let nextOpinionatedRequestNonce = 1;

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(EXTENSION_DIR, "compaction-prompt.md");

const COMPACTIONS_DIR = path.join(homedir(), ".pi", "agent", "extensions", "diligent-compact", "compactions");
const LATEST_ALIGNMENT_DIAGNOSTIC_PATH = path.join(COMPACTIONS_DIR, "latest-alignment-divergence.json");

const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. " +
	"Do NOT continue the conversation. " +
	"Do NOT answer any questions in the conversation. " +
	"ONLY output the structured summary requested by the user prompt.";

const DEFAULT_PROMPT_BODY =
	"Output ONLY markdown. Keep it concise. Use the exact format requested in the user prompt.";

function saveCompactionDebug(sessionId: string, data: unknown): void {
	if (!CONFIG.debugCompactions) return;
	try {
		mkdirSync(COMPACTIONS_DIR, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `${timestamp}_${sessionId.slice(0, 8)}.json`;
		writeFileSync(path.join(COMPACTIONS_DIR, filename), JSON.stringify(data, null, 2));
	} catch {
		// ignore
	}
}

function getRuntimeSessionId(ctx: ExtensionContext): string | null {
	return ctx.sessionManager.getSessionId?.() ?? null;
}

function getSessionId(ctx: ExtensionContext): string {
	return getRuntimeSessionId(ctx) ?? "unknown-session";
}

function clearPendingCompactionRequest(sessionId: string, nonce?: number): void {
	const request = pendingCompactionRequests.get(sessionId);
	if (!request) return;
	if (nonce !== undefined && request.nonce !== nonce) return;
	pendingCompactionRequests.delete(sessionId);
}

function armPendingCompactionRequest(
	ctx: ExtensionCommandContext,
	mode: PendingCompactionRequest["mode"],
	fallbackThinkingLevel: ThinkingLevel,
): { sessionId: string; nonce: number } {
	const sessionId = getSessionId(ctx);
	const nonce = nextOpinionatedRequestNonce++;
	pendingCompactionRequests.set(sessionId, {
		expiresAt: Date.now() + OPINIONATED_REQUEST_TTL_MS,
		nonce,
		mode,
		fallbackThinkingLevel,
	});
	return { sessionId, nonce };
}

function isPendingCompactionRequest(sessionId: string, nonce: number): boolean {
	return pendingCompactionRequests.get(sessionId)?.nonce === nonce;
}

function consumePendingCompactionRequest(ctx: ExtensionContext): PendingCompactionRequest | null {
	const sessionId = getSessionId(ctx);
	const request = pendingCompactionRequests.get(sessionId);
	if (!request) return null;
	if (request.expiresAt < Date.now()) {
		pendingCompactionRequests.delete(sessionId);
		return null;
	}
	pendingCompactionRequests.delete(sessionId);
	return request;
}

function createFileOps(): FileOpsLike {
	return {
		read: new Set<string>(),
		written: new Set<string>(),
		edited: new Set<string>(),
	};
}

function extractFileOpsFromVisibleMessage(message: EventMessage, fileOps: FileOpsLike): void {
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

function extractVisibleFileOps(messages: EventMessage[]): FileOpsLike {
	const fileOps = createFileOps();
	for (const message of messages) {
		extractFileOpsFromVisibleMessage(message, fileOps);
	}
	return fileOps;
}

function isResolvedDiligentSnapshot(snapshot: DiligentContextRuntimeSnapshot | null): boolean {
	return Boolean(
		snapshot &&
			snapshot.state.enabled &&
			snapshot.state.anchorMode !== "pending-here" &&
			snapshot.resolvedAnchorIndex !== null,
	);
}

function reconcileSnapshotWithState(
	sessionId: string,
	snapshot: DiligentContextRuntimeSnapshot | null,
	state: DiligentContextState,
): DiligentContextRuntimeSnapshot | null {
	if (!snapshot) return null;
	if (getDiligentContextStateSignature(snapshot.state) === getDiligentContextStateSignature(state)) {
		return snapshot;
	}
	if (!snapshot.rawMessages) return null;
	const rebuilt = buildRuntimeSnapshotFromRawMessages(snapshot.rawMessages, state);
	setDiligentContextRuntimeSnapshot(sessionId, rebuilt);
	return rebuilt;
}

function buildCheckpointPreviousSummary(state: DiligentContextState): string | undefined {
	const checkpoints = getActiveCheckpoints(state);
	if (checkpoints.length === 0) return undefined;
	return checkpoints.map((checkpoint) => buildCheckpointDisplayText(checkpoint)).join("\n\n");
}

function getCurrentAnchorSignature(snapshot: DiligentContextRuntimeSnapshot | null): string | null {
	if (!snapshot || !snapshot.state.enabled || snapshot.state.anchorMode === "pending-here" || snapshot.resolvedAnchorIndex === null || !snapshot.state.anchorFingerprint) {
		return null;
	}
	return JSON.stringify({
		anchorMode: snapshot.state.anchorMode,
		anchorFingerprint: snapshot.state.anchorFingerprint,
	});
}

type RawContextAlignmentResult =
	| {
			ok: true;
			rawIndexToEntryId: string[];
			stats: AlignmentStats;
		}
	| {
			ok: false;
			diagnostic: AlignmentDivergenceDiagnostic;
		};

function buildAlignmentStats(
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

function summarizeComparableMessage(
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

function summarizeRawMessage(message: EventMessage, index: number): DiagnosticMessageSummary {
	return summarizeComparableMessage(index, getContextAlignmentComparable(message));
}

function summarizeContextEntry(entry: ContextMessageEntry, index: number): DiagnosticMessageSummary {
	return summarizeComparableMessage(index, getContextAlignmentComparable(entry.message), entry.sourceType);
}

function buildRawWindow(rawMessages: EventMessage[], center: number | null): DiagnosticMessageSummary[] {
	if (rawMessages.length === 0) return [];
	const normalizedCenter = center === null ? rawMessages.length - 1 : Math.max(0, Math.min(center, rawMessages.length - 1));
	const start = Math.max(0, normalizedCenter - 1);
	const end = Math.min(rawMessages.length, normalizedCenter + 3);
	const out: DiagnosticMessageSummary[] = [];
	for (let i = start; i < end; i++) out.push(summarizeRawMessage(rawMessages[i], i));
	return out;
}

function buildContextWindow(contextEntries: ContextMessageEntry[], center: number | null): DiagnosticMessageSummary[] {
	if (contextEntries.length === 0) return [];
	const normalizedCenter = center === null ? contextEntries.length - 1 : Math.max(0, Math.min(center, contextEntries.length - 1));
	const start = Math.max(0, normalizedCenter - 1);
	const end = Math.min(contextEntries.length, normalizedCenter + 3);
	const out: DiagnosticMessageSummary[] = [];
	for (let i = start; i < end; i++) out.push(summarizeContextEntry(contextEntries[i], i));
	return out;
}

function buildAlignmentDivergenceDiagnostic(args: {
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

function alignRawMessagesToContextEntries(
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

function getLatestCompactionBranchMetadata(branchEntries: SessionBeforeCompactEvent["branchEntries"]): {
	compactionEntryId: string | null;
	firstKeptEntryId: string | null;
	foundFirstKeptInBranch: boolean | null;
} {
	let latestCompactionIndex = -1;
	let latestCompactionEntry: { id?: unknown; firstKeptEntryId?: unknown; type?: unknown } | null = null;
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i] as { id?: unknown; firstKeptEntryId?: unknown; type?: unknown };
		if (entry.type === "compaction") {
			latestCompactionIndex = i;
			latestCompactionEntry = entry;
		}
	}
	if (!latestCompactionEntry || latestCompactionIndex < 0) {
		return {
			compactionEntryId: null,
			firstKeptEntryId: null,
			foundFirstKeptInBranch: null,
		};
	}
	const firstKeptEntryId = typeof latestCompactionEntry.firstKeptEntryId === "string"
		? latestCompactionEntry.firstKeptEntryId
		: null;
	const foundFirstKeptInBranch = firstKeptEntryId === null
		? null
		: branchEntries.slice(0, latestCompactionIndex).some((entry) => (entry as { id?: unknown }).id === firstKeptEntryId);
	return {
		compactionEntryId: typeof latestCompactionEntry.id === "string" ? latestCompactionEntry.id : null,
		firstKeptEntryId,
		foundFirstKeptInBranch,
	};
}

function saveAlignmentDiagnostic(args: {
	sessionId: string;
	route: Exclude<CompactionRoute, "native">;
	blockedReason: "no-live-payload" | "anchor-restoring" | "context-mapping-mismatch" | "nothing-visible-to-compact";
	blockedMessage: string;
	diagnostic?: VisiblePreparationFailureDiagnostic;
	snapshot: DiligentContextRuntimeSnapshot | null;
	preparation: CompactionPreparation;
	branchEntries: SessionBeforeCompactEvent["branchEntries"];
	customInstructions?: string;
}): string | null {
	const payload = {
		kind: args.route === "force-native" ? "alignment_bypass" : "alignment_blocked",
		timestamp: new Date().toISOString(),
		sessionId: args.sessionId,
		route: args.route,
		blockedReason: args.blockedReason,
		blockedMessage: args.blockedMessage,
		diligentState: args.snapshot
			? {
				enabled: args.snapshot.state.enabled,
				anchorMode: args.snapshot.state.anchorMode,
				resolvedAnchorIndex: args.snapshot.resolvedAnchorIndex,
			}
			: null,
		snapshotCounts: args.snapshot
			? {
				rawMessages: args.snapshot.rawMessages?.length ?? 0,
				filteredMessages: args.snapshot.filteredMessages?.length ?? 0,
				filteredToRawIndices: args.snapshot.filteredToRawIndices.length,
			}
			: null,
		preparationCounts: {
			keepRecentTokens: typeof args.preparation.settings?.keepRecentTokens === "number"
				? args.preparation.settings.keepRecentTokens
				: null,
			reserveTokens: typeof args.preparation.settings?.reserveTokens === "number"
				? args.preparation.settings.reserveTokens
				: null,
			messagesToSummarize: args.preparation.messagesToSummarize.length,
			turnPrefixMessages: args.preparation.turnPrefixMessages.length,
			isSplitTurn: Boolean(args.preparation.isSplitTurn),
			customInstructionsPresent: Boolean(args.customInstructions && args.customInstructions.trim().length > 0),
		},
		latestCompaction: getLatestCompactionBranchMetadata(args.branchEntries),
		diagnostic: args.diagnostic ?? null,
	};
	try {
		mkdirSync(COMPACTIONS_DIR, { recursive: true });
		writeFileSync(LATEST_ALIGNMENT_DIAGNOSTIC_PATH, JSON.stringify(payload, null, 2));
		if (CONFIG.debugCompactions) {
			saveCompactionDebug(args.sessionId, payload);
		}
		return LATEST_ALIGNMENT_DIAGNOSTIC_PATH;
	} catch {
		return null;
	}
}

function formatBlockedAlignmentSummary(
	route: CompactionRoute,
	diagnostic?: VisiblePreparationFailureDiagnostic,
): string {
	const alignment = diagnostic?.kind === "raw-context-alignment-divergence" ? diagnostic.alignment : null;
	if (!alignment) {
		return route === "compatibility"
			? "/compact blocked: live/session alignment failed — diagnostic saved; run /diligent-compact --force-native to compact once without visibility guarantees"
			: "diligent-compact blocked: live/session alignment failed — diagnostic saved; rerun with /diligent-compact --force-native to compact once without visibility guarantees";
	}
	const rawPosition = alignment.rawIndex === null ? "end" : `${alignment.rawIndex + 1}/${alignment.stats.rawMessageCount}`;
	const mismatch = alignment.mismatchFields && alignment.mismatchFields.length > 0
		? ` (${alignment.mismatchFields.join(", ")})`
		: "";
	const prefix = route === "compatibility" ? "/compact blocked" : "diligent-compact blocked";
	return `${prefix}: live/session alignment diverged at ${rawPosition}${mismatch} — diagnostic saved; run /diligent-compact --force-native to compact once without visibility guarantees`;
}

function logBlockedAlignmentDiagnostic(args: {
	route: CompactionRoute;
	blockedReason: "no-live-payload" | "anchor-restoring" | "context-mapping-mismatch" | "nothing-visible-to-compact";
	diagnostic?: VisiblePreparationFailureDiagnostic;
}): void {
	if (args.diagnostic?.kind !== "raw-context-alignment-divergence") return;
	const alignment = args.diagnostic.alignment;
	const mismatch = alignment.mismatchFields && alignment.mismatchFields.length > 0 ? ` fields=${alignment.mismatchFields.join(",")}` : "";
	console.log(
		`[diligent-compact.alignment] route=${args.route} kind=${alignment.kind} matched=${alignment.stats.matchedPrefixCount}/${alignment.stats.rawMessageCount} rawIndex=${alignment.rawIndex ?? "end"} contextIndex=${alignment.contextIndex ?? "end"}${mismatch}`,
	);
}

function parseDiligentCompactArgs(args: string): {
	forceNative: boolean;
	customInstructions?: string;
	invalidOption?: string;
} {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { forceNative: false };
	const [firstToken, ...restTokens] = trimmed.split(/\s+/);
	if (firstToken === "--force-native") {
		const rest = restTokens.join(" ").trim();
		return {
			forceNative: true,
			customInstructions: rest.length > 0 ? rest : undefined,
		};
	}
	if (firstToken?.startsWith("--")) {
		return { forceNative: false, invalidOption: firstToken };
	}
	return {
		forceNative: false,
		customInstructions: trimmed,
	};
}

function findPreferredVisibleCutIndex(messages: EventMessage[], minIndex: number): number {
	for (let i = minIndex; i < messages.length; i++) {
		if (getPayloadNarrativeLabel(messages[i]) !== null) return i;
	}
	return Math.min(minIndex, messages.length - 1);
}

function computeFirstKeptVisibleIndex(messages: EventMessage[], keepRecentTokens: number): number {
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

function buildVisiblePreparation(
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

function attachDiligentDetails(
	result: CompactionResult,
	route: Exclude<CompactionRoute, "native">,
	anchorSignature: string | null,
): CompactionResult {
	const baseDetails = result.details;
	const detailObject = baseDetails && typeof baseDetails === "object" && !Array.isArray(baseDetails)
		? baseDetails as Record<string, unknown>
		: baseDetails === undefined
			? {}
			: { upstreamDetails: baseDetails };
	return {
		...result,
		details: {
			...detailObject,
			route,
			diligentContextAnchorSignature: anchorSignature ?? undefined,
		},
	};
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	console.log(`[diligent-compact] ${level}: ${text}`);
}

function setCompactionStatus(ctx: ExtensionContext, text?: string): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(COMPACTION_STATUS_KEY, text ? theme.fg("accent", text) : undefined);
}

function clearCompactionSummaryWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(COMPACTION_SUMMARY_WIDGET_KEY, undefined, { placement: "aboveEditor" });
}

function showCompactionSummaryWidget(ctx: ExtensionContext, args: { summary: string; tokensBefore: number; timestamp: string }): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(
		COMPACTION_SUMMARY_WIDGET_KEY,
		() => {
			const component = new CompactionSummaryMessageComponent(
				{
					role: "compactionSummary",
					summary: args.summary,
					tokensBefore: args.tokensBefore,
					timestamp: new Date(args.timestamp).getTime(),
				},
				getMarkdownTheme(),
			);
			component.setExpanded(true);
			return component;
		},
		{ placement: "aboveEditor" },
	);
}

function buildCompatibilityPromptEstimate(args: {
	conversationText: string;
	previousSummary?: string;
	customInstructions?: string;
}): string {
	return buildTaggedPromptText([
		{ tag: "conversation", text: args.conversationText },
		{ tag: "previous-summary", text: args.previousSummary },
		{ text: "Create a structured context checkpoint summary that another LLM will use to continue the work." },
		{
			text: args.customInstructions?.trim()
				? `Additional focus: ${args.customInstructions.trim()}`
				: undefined,
		},
	]);
}

function buildOpinionatedPromptText(args: {
	previousSummary?: string;
	conversationText: string;
	splitTurnPrefixText?: string;
	customInstructions?: string;
	promptBody: string;
}): string {
	return buildTaggedPromptText([
		{ tag: "previous_compaction_summary", text: args.previousSummary },
		{ tag: "conversation", text: args.conversationText },
		{ tag: "split_turn_prefix", text: args.splitTurnPrefixText },
		{ tag: "custom_instructions", text: args.customInstructions },
		{ text: args.promptBody },
	]);
}

export default function diligentCompactExtension(pi: ExtensionAPI) {
	pi.registerCommand("diligent-compact", {
		description: "Run visibility-aware compaction. Usage: /diligent-compact [instructions] or /diligent-compact --force-native [instructions]",
		handler: async (args, ctx) => {
			const parsed = parseDiligentCompactArgs(args);
			if (parsed.invalidOption) {
				notify(ctx, `diligent-compact: unknown option ${parsed.invalidOption}`, "warning");
				return;
			}
			const mode: PendingCompactionRequest["mode"] = parsed.forceNative ? "force-native" : "opinionated";
			const { sessionId, nonce } = armPendingCompactionRequest(ctx, mode, pi.getThinkingLevel());
			clearCompactionSummaryWidget(ctx);
			setCompactionStatus(
				ctx,
				mode === "force-native" ? "diligent-compact: native override (unsafe)" : "diligent-compact: running",
			);
			if (mode === "force-native") {
				notify(
					ctx,
					"diligent-compact: using native Pi compaction for this run — diligent visibility guarantees are suspended",
					"warning",
				);
			}
			try {
				ctx.compact({
					customInstructions: parsed.customInstructions,
					onComplete: (result) => {
						clearPendingCompactionRequest(sessionId, nonce);
						setCompactionStatus(ctx, undefined);
						notify(
							ctx,
							mode === "force-native"
								? `diligent-compact complete: native compaction finished (${formatTokens(result.tokensBefore)} before compaction) — visibility guarantees were bypassed for this run`
								: `diligent-compact complete: visible context checkpoint saved (${formatTokens(result.tokensBefore)} before compaction)`,
							"info",
						);
					},
					onError: (error) => {
						const shouldNotify = mode === "force-native" ? true : isPendingCompactionRequest(sessionId, nonce);
						clearPendingCompactionRequest(sessionId, nonce);
						setCompactionStatus(ctx, undefined);
						if (!shouldNotify) return;
						const message = error instanceof Error ? error.message : String(error);
						if (message === "Compaction cancelled") return;
						notify(
							ctx,
							mode === "force-native"
								? `diligent-compact native override failed: ${message}`
								: `diligent-compact failed: ${message}`,
							"warning",
						);
					},
				});
			} catch (error) {
				clearPendingCompactionRequest(sessionId, nonce);
				setCompactionStatus(ctx, undefined);
				throw error;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		clearCompactionSummaryWidget(ctx);
		setCompactionStatus(ctx, undefined);
	});

	pi.on("session_switch", async (_event, ctx) => {
		clearCompactionSummaryWidget(ctx);
		setCompactionStatus(ctx, undefined);
	});

	pi.on("session_compact", async (event, ctx) => {
		const details = (event.compactionEntry.details && typeof event.compactionEntry.details === "object" && !Array.isArray(event.compactionEntry.details))
			? event.compactionEntry.details as DiligentCompactionDetails
			: null;
		if (details?.route === "opinionated") {
			showCompactionSummaryWidget(ctx, {
				summary: event.compactionEntry.summary,
				tokensBefore: event.compactionEntry.tokensBefore,
				timestamp: event.compactionEntry.timestamp,
			});
			return;
		}
		clearCompactionSummaryWidget(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, signal, customInstructions } = event as SessionBeforeCompactEvent;
		const runtimeSessionId = getRuntimeSessionId(ctx);
		const sessionId = getSessionId(ctx);
		const pendingRequest = consumePendingCompactionRequest(ctx);
		const runtimeSnapshot = getDiligentContextRuntimeSnapshot(runtimeSessionId);
		const diligentState = loadStateFromEntries(branchEntries as SessionEntry[]);
		const effectiveSnapshot = reconcileSnapshotWithState(sessionId, runtimeSnapshot, diligentState);
		const route: CompactionRoute = pendingRequest?.mode === "force-native"
			? "force-native"
			: pendingRequest?.mode === "opinionated"
				? "opinionated"
				: diligentState.enabled
					? "compatibility"
					: "native";

		if (signal.aborted) {
			debugLog("Compaction aborted before start");
			return { cancel: true };
		}

		if (route === "native") {
			return undefined;
		}

		const visiblePreparation = buildVisiblePreparation(effectiveSnapshot, diligentState, preparation, branchEntries);
		if (route === "force-native") {
			if (isVisiblePreparationFailure(visiblePreparation)) {
				const artifactPath = visiblePreparation.reason === "context-mapping-mismatch"
					? saveAlignmentDiagnostic({
						sessionId,
						route,
						blockedReason: visiblePreparation.reason,
						blockedMessage: visiblePreparation.message,
						diagnostic: visiblePreparation.diagnostic,
						snapshot: effectiveSnapshot,
						preparation,
						branchEntries,
						customInstructions,
					})
					: null;
				logBlockedAlignmentDiagnostic({
					route,
					blockedReason: visiblePreparation.reason,
					diagnostic: visiblePreparation.diagnostic,
				});
				debugLog(`route=force-native bypass blocked=${visiblePreparation.reason}${artifactPath ? ` artifact=${artifactPath}` : ""}`);
			}
			return undefined;
		}

		if (isVisiblePreparationFailure(visiblePreparation)) {
			const blockedMessage = visiblePreparation.message;
			const blockedReason = visiblePreparation.reason;
			const artifactPath = blockedReason === "context-mapping-mismatch"
				? saveAlignmentDiagnostic({
					sessionId,
					route,
					blockedReason,
					blockedMessage,
					diagnostic: visiblePreparation.diagnostic,
					snapshot: effectiveSnapshot,
					preparation,
					branchEntries,
					customInstructions,
				})
				: null;
			logBlockedAlignmentDiagnostic({ route, blockedReason, diagnostic: visiblePreparation.diagnostic });
			notify(
				ctx,
				blockedReason === "context-mapping-mismatch"
					? formatBlockedAlignmentSummary(route, visiblePreparation.diagnostic)
					: route === "opinionated"
						? `diligent-compact blocked: ${blockedMessage}`
						: `/compact blocked: ${blockedMessage}`,
				"warning",
			);
			debugLog(`route=${route} blocked=${blockedReason}${artifactPath ? ` artifact=${artifactPath}` : ""}`);
			return { cancel: true };
		}

		const { preparation: visibleCompactionPreparation, anchorSignature, totalVisibleMessages, summarizedVisibleMessages, keptVisibleMessages } = visiblePreparation;
		debugLog(
			`route=${route} visibleTotal=${totalVisibleMessages} summarize=${summarizedVisibleMessages} keep=${keptVisibleMessages} firstKept=${visibleCompactionPreparation.firstKeptEntryId}`,
		);

		try {
			const result = route === "opinionated"
				? await runOpinionatedCompactionRequest({
					ctx,
					preparation: visibleCompactionPreparation,
					promptText: buildOpinionatedPromptText({
						previousSummary: typeof visibleCompactionPreparation.previousSummary === "string"
							? visibleCompactionPreparation.previousSummary
							: undefined,
						conversationText: serializeConversation(convertToLlm(visibleCompactionPreparation.messagesToSummarize)),
						splitTurnPrefixText: visibleCompactionPreparation.isSplitTurn && visibleCompactionPreparation.turnPrefixMessages.length > 0
							? serializeConversation(convertToLlm(visibleCompactionPreparation.turnPrefixMessages))
							: undefined,
						customInstructions,
						promptBody: readOptionalTextFile(PROMPT_PATH, DEFAULT_PROMPT_BODY),
					}),
					systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
					customInstructions,
					signal,
					fallbackThinkingLevel: pendingRequest?.fallbackThinkingLevel ?? CONFIG.thinkingLevel,
					notify: (text, level = "info") => notify(ctx, text, level),
					onDebug: CONFIG.debugCompactions ? (payload) => saveCompactionDebug(sessionId, payload) : undefined,
				})
				: await runCompatibilityCompactionRequest({
					ctx,
					preparation: visibleCompactionPreparation,
					customInstructions,
					signal,
					systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
					promptEstimateText: buildCompatibilityPromptEstimate({
						conversationText: serializeConversation(convertToLlm(visibleCompactionPreparation.messagesToSummarize)),
						previousSummary: typeof visibleCompactionPreparation.previousSummary === "string"
							? visibleCompactionPreparation.previousSummary
							: undefined,
						customInstructions,
					}),
					onDebug: CONFIG.debugCompactions ? (payload) => saveCompactionDebug(sessionId, payload) : undefined,
				});

			return { compaction: attachDiligentDetails(result, route, anchorSignature) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (signal.aborted || message === "Compaction cancelled") {
				return { cancel: true };
			}
			if (route === "compatibility") {
				notify(
					ctx,
					`/compact blocked: visibility-aware compaction failed (${message}). The current live context was preserved.`,
					"warning",
				);
				saveCompactionDebug(sessionId, {
					kind: "compatibility_error",
					error: message,
					visibleMessagesCount: visibleCompactionPreparation.messagesToSummarize.length,
					customInstructionsPresent: Boolean(customInstructions),
				});
				return { cancel: true };
			}

			notify(ctx, `diligent-compact failed: ${message}`, "warning");
			saveCompactionDebug(sessionId, {
				kind: "opinionated_error",
				error: message,
				visibleMessagesCount: visibleCompactionPreparation.messagesToSummarize.length,
				customInstructionsPresent: Boolean(customInstructions),
			});
			return { cancel: true };
		}
	});
}
