/**
 * Diligent Compact Extension
 *
 * Routes compaction through one of three modes:
 * - native: let Pi's built-in /compact run unchanged
 * - compatibility: run Pi's native compaction helper on only the diligent-visible slice
 * - opinionated: run our custom model/prompt compactor on the diligent-visible slice
 */

import { completeSimple, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
	compact as runNativeCompact,
	CompactionSummaryMessageComponent,
	convertToLlm,
	estimateTokens,
	getMarkdownTheme,
	serializeConversation,
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import {
	getContextAlignmentComparable,
	getContextAlignmentMismatchFields,
	getDiligentContextRuntimeSnapshot,
	estimatePayloadTokens,
	formatTokens,
	getPayloadNarrativeLabel,
	getToolCallNames,
	messagesMatchForContextAlignment,
	loadStateFromEntries,
	type ContextAlignmentComparable,
	type ContextAlignmentField,
	type ContextMessageEntry,
	type DiligentContextRuntimeSnapshot,
	type EventMessage,
	type SessionEntry,
	buildContextMessageEntries,
} from "../diligent-context/core.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const OPINIONATED_REQUEST_TTL_MS = 10_000;
const COMPACTION_TIMEOUT_MS = 180_000;
const COMPACTION_STATUS_KEY = "diligent-compact";
const COMPACTION_SUMMARY_WIDGET_KEY = "diligent-compact-summary";

const pendingCompactionRequests = new Map<string, PendingCompactionRequest>();
let nextOpinionatedRequestNonce = 1;

type CompactionModelConfig = {
	provider: string;
	id: string;
	/** Optional per-model thinking level override */
	thinkingLevel?: ThinkingLevel;
};

type ExtensionConfig = {
	compactionModels: CompactionModelConfig[];
	thinkingLevel: ThinkingLevel;
	debugCompactions: boolean;
};

const DEFAULT_CONFIG: ExtensionConfig = {
	compactionModels: [
		{ provider: "openai-codex", id: "gpt-5.4" },
		{ provider: "anthropic", id: "claude-opus-4-6" },
	],
	thinkingLevel: "high",
	debugCompactions: false,
};

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");
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

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.toLowerCase().trim() as ThinkingLevel;
	return VALID_THINKING_LEVELS.includes(lower) ? lower : undefined;
}

function loadConfig(): ExtensionConfig {
	if (!existsSync(CONFIG_PATH)) {
		return DEFAULT_CONFIG;
	}

	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ExtensionConfig>;

		const compactionModels = Array.isArray(parsed.compactionModels)
			? parsed.compactionModels
					.filter((m): m is CompactionModelConfig => Boolean(m) && typeof m.provider === "string" && typeof m.id === "string")
					.map((m) => ({
						provider: m.provider,
						id: m.id,
						thinkingLevel: normalizeThinkingLevel(m.thinkingLevel),
					}))
			: DEFAULT_CONFIG.compactionModels;

		const thinkingLevel = normalizeThinkingLevel(parsed.thinkingLevel) ?? DEFAULT_CONFIG.thinkingLevel;

		const debugCompactions = typeof parsed.debugCompactions === "boolean"
			? parsed.debugCompactions
			: DEFAULT_CONFIG.debugCompactions;

		return {
			compactionModels,
			thinkingLevel,
			debugCompactions,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

// Loaded once at module init (config changes require Pi restart).
const CONFIG = loadConfig();

function loadPromptBody(): string {
	try {
		if (existsSync(PROMPT_PATH)) {
			const text = readFileSync(PROMPT_PATH, "utf8").trim();
			if (text.length > 0) return text;
		}
	} catch {
		// fall back
	}
	return DEFAULT_PROMPT_BODY;
}

function debugLog(message: string): void {
	if (!CONFIG.debugCompactions) return;
	try {
		mkdirSync(COMPACTIONS_DIR, { recursive: true });
		appendFileSync(path.join(COMPACTIONS_DIR, "debug.log"), `[${new Date().toISOString()}] ${message}\n`);
	} catch {
		// ignore
	}
}

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

function buildPromptText(args: {
	previousSummary?: string;
	conversationText: string;
	splitTurnPrefixText?: string;
	customInstructions?: string;
	promptBody: string;
}): string {
	const blocks: string[] = [];

	const prev = (args.previousSummary ?? "").trim();
	if (prev.length > 0) {
		blocks.push(`<previous_compaction_summary>\n${prev}\n</previous_compaction_summary>`);
	}

	blocks.push(`<conversation>\n${args.conversationText.trim()}\n</conversation>`);

	const splitPrefix = (args.splitTurnPrefixText ?? "").trim();
	if (splitPrefix.length > 0) {
		blocks.push(`<split_turn_prefix>\n${splitPrefix}\n</split_turn_prefix>`);
	}

	const ci = (args.customInstructions ?? "").trim();
	if (ci.length > 0) {
		blocks.push(`<custom_instructions>\n${ci}\n</custom_instructions>`);
	}

	blocks.push(args.promptBody.trim());

	return blocks.join("\n\n").trim();
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
	if (snapshot.state.enabled && !isResolvedDiligentSnapshot(snapshot)) {
		return {
			ok: false,
			reason: "anchor-restoring",
			message: "the current diligent-context boundary is still restoring — send a message first",
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
	return {
		ok: true,
		preparation: {
			...preparation,
			firstKeptEntryId,
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			previousSummary: undefined,
			tokensBefore: estimatePayloadTokens(snapshot.filteredMessages),
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

function startTimedCompactionSignal(parent: AbortSignal, timeoutMs: number): {
	signal: AbortSignal;
	cleanup: () => void;
	didTimeout: () => boolean;
} {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = (): void => controller.abort();
	if (parent.aborted) {
		controller.abort();
	} else {
		parent.addEventListener("abort", abortFromParent, { once: true });
	}
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			parent.removeEventListener("abort", abortFromParent);
		},
		didTimeout: () => timedOut,
	};
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimatePromptInputTokens(systemPrompt: string, promptText: string, extraOverheadTokens: number = 0): number {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: promptText }],
		timestamp: 0,
	};
	return estimateTokens(userMessage as never) + estimateTextTokens(systemPrompt) + extraOverheadTokens;
}

function getSafePromptInputBudget(model: Model<any>, maxTokens?: number): number {
	const contextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 128000;
	const outputReserve = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
	const safetyMargin = Math.min(4096, Math.max(1024, Math.floor(contextWindow * 0.03)));
	return Math.max(0, contextWindow - outputReserve - safetyMargin);
}

function assertPromptFitsBudget(args: {
	label: string;
	model: Model<any>;
	systemPrompt: string;
	promptText: string;
	maxTokens?: number;
	extraOverheadTokens?: number;
}): void {
	const estimatedInputTokens = estimatePromptInputTokens(
		args.systemPrompt,
		args.promptText,
		args.extraOverheadTokens ?? 0,
	);
	const safeBudget = getSafePromptInputBudget(args.model, args.maxTokens);
	if (estimatedInputTokens <= safeBudget) return;
	throw new Error(
		`${args.label} prompt too large for ${args.model.provider}/${args.model.id}: estimated input ${formatTokens(estimatedInputTokens)} exceeds safe budget ${formatTokens(safeBudget)}`,
	);
}

function buildCompatibilityPromptEstimate(args: {
	conversationText: string;
	previousSummary?: string;
	customInstructions?: string;
}): string {
	let promptText = `<conversation>\n${args.conversationText}\n</conversation>\n\n`;
	const previousSummary = (args.previousSummary ?? "").trim();
	if (previousSummary.length > 0) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += "Create a structured context checkpoint summary that another LLM will use to continue the work.";
	const customInstructions = (args.customInstructions ?? "").trim();
	if (customInstructions.length > 0) {
		promptText += `\n\nAdditional focus: ${customInstructions}`;
	}
	return promptText;
}

async function getCurrentModelWithApiKey(
	ctx: ExtensionContext,
): Promise<{ model: Model<any>; apiKey: string } | null> {
	if (!ctx.model) return null;
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;
	return { model: ctx.model, apiKey };
}

async function selectOpinionatedModel(
	ctx: ExtensionContext,
	fallbackThinkingLevel: ThinkingLevel,
): Promise<{ model: Model<any>; apiKey: string; thinkingLevel: ThinkingLevel } | null> {
	for (const cfg of CONFIG.compactionModels) {
		const registryModel = ctx.modelRegistry
			.getAll()
			.find((model) => model.provider === cfg.provider && model.id === cfg.id);
		if (!registryModel) {
			debugLog(`Model ${cfg.provider}/${cfg.id} not registered`);
			continue;
		}
		const apiKey = await ctx.modelRegistry.getApiKey(registryModel);
		if (!apiKey) {
			debugLog(`No API key for ${cfg.provider}/${cfg.id}`);
			continue;
		}
		return {
			model: registryModel,
			apiKey,
			thinkingLevel: cfg.thinkingLevel ?? CONFIG.thinkingLevel,
		};
	}

	const current = await getCurrentModelWithApiKey(ctx);
	if (!current) return null;
	return {
		model: current.model,
		apiKey: current.apiKey,
		thinkingLevel: fallbackThinkingLevel,
	};
}

async function runCompatibilityCompaction(args: {
	ctx: ExtensionContext;
	preparation: CompactionPreparation;
	customInstructions?: string;
	signal: AbortSignal;
	sessionId: string;
}): Promise<CompactionResult> {
	const modelWithKey = await getCurrentModelWithApiKey(args.ctx);
	if (!modelWithKey) {
		throw new Error("No current model/API key available for compatibility compaction");
	}
	const reserveTokens = args.preparation.settings?.reserveTokens;
	const historyMaxTokens = (typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens > 0)
		? Math.floor(0.8 * reserveTokens)
		: undefined;
	if (args.preparation.messagesToSummarize.length > 0) {
		const historyPromptText = buildCompatibilityPromptEstimate({
			conversationText: serializeConversation(convertToLlm(args.preparation.messagesToSummarize)),
			previousSummary: typeof args.preparation.previousSummary === "string" ? args.preparation.previousSummary : undefined,
			customInstructions: args.customInstructions,
		});
		assertPromptFitsBudget({
			label: "compatibility compaction",
			model: modelWithKey.model,
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			promptText: historyPromptText,
			maxTokens: historyMaxTokens,
			extraOverheadTokens: 1536,
		});
	}
	if (args.preparation.isSplitTurn && args.preparation.turnPrefixMessages.length > 0) {
		const splitPromptText = `<conversation>\n${serializeConversation(convertToLlm(args.preparation.turnPrefixMessages))}\n</conversation>\n\nSummarize only the retained turn prefix context.`;
		assertPromptFitsBudget({
			label: "compatibility split-turn compaction",
			model: modelWithKey.model,
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			promptText: splitPromptText,
			maxTokens: typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens > 0
				? Math.floor(0.5 * reserveTokens)
				: undefined,
			extraOverheadTokens: 1024,
		});
	}
	debugLog(
		`route=compatibility provider=${modelWithKey.model.provider} model=${modelWithKey.model.id} delta=${args.preparation.messagesToSummarize.length} prefix=${args.preparation.turnPrefixMessages.length}`,
	);
	const timed = startTimedCompactionSignal(args.signal, COMPACTION_TIMEOUT_MS);
	try {
		const result = await runNativeCompact(
			args.preparation,
			modelWithKey.model,
			modelWithKey.apiKey,
			args.customInstructions,
			timed.signal,
		);
		if (timed.didTimeout()) {
			throw new Error(`compatibility compaction timed out after ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s`);
		}
		if (CONFIG.debugCompactions) {
			saveCompactionDebug(args.sessionId, {
				kind: "compatibility_success",
				provider: modelWithKey.model.provider,
				model: modelWithKey.model.id,
				messagesToSummarizeCount: args.preparation.messagesToSummarize.length,
				turnPrefixMessagesCount: args.preparation.turnPrefixMessages.length,
				usedPreviousSummary: Boolean(args.preparation.previousSummary),
				customInstructionsPresent: Boolean(args.customInstructions),
				outputSummaryChars: result.summary.length,
			});
		}
		return result;
	} catch (error) {
		if (timed.didTimeout()) {
			throw new Error(`compatibility compaction timed out after ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s`);
		}
		throw error;
	} finally {
		timed.cleanup();
	}
}

async function runOpinionatedCompaction(args: {
	ctx: ExtensionContext;
	preparation: CompactionPreparation;
	customInstructions?: string;
	signal: AbortSignal;
	sessionId: string;
	fallbackThinkingLevel: ThinkingLevel;
}): Promise<CompactionResult> {
	const selected = await selectOpinionatedModel(args.ctx, args.fallbackThinkingLevel);
	if (!selected) {
		throw new Error("No model/API key available for opinionated compaction");
	}

	const previousSummary = typeof args.preparation.previousSummary === "string"
		? args.preparation.previousSummary
		: undefined;
	const isSplitTurn = Boolean(args.preparation.isSplitTurn);
	const conversationText = serializeConversation(convertToLlm(args.preparation.messagesToSummarize));
	const splitTurnPrefixText = (isSplitTurn && args.preparation.turnPrefixMessages.length > 0)
		? serializeConversation(convertToLlm(args.preparation.turnPrefixMessages))
		: undefined;
	const promptBody = loadPromptBody();
	const promptText = buildPromptText({
		previousSummary,
		conversationText,
		splitTurnPrefixText,
		customInstructions: args.customInstructions,
		promptBody,
	});

	const reserveTokens = args.preparation.settings?.reserveTokens;
	const maxTokens = (typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens > 0)
		? Math.floor(0.8 * reserveTokens)
		: undefined;
	assertPromptFitsBudget({
		label: "diligent-compact",
		model: selected.model,
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		promptText,
		maxTokens,
		extraOverheadTokens: 512,
	});

	notify(
		args.ctx,
		`diligent-compact: compacting ${args.preparation.messagesToSummarize.length} visible messages with ${selected.model.provider}/${selected.model.id} (thinking: ${selected.thinkingLevel})`,
		"info",
	);

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: promptText }],
		timestamp: Date.now(),
	};

	const completeOptions: {
		apiKey: string;
		signal: AbortSignal;
		reasoning?: ThinkingLevel;
		maxTokens?: number;
	} = {
		apiKey: selected.apiKey,
		signal: args.signal,
	};
	if (selected.thinkingLevel !== "off") {
		completeOptions.reasoning = selected.thinkingLevel;
	}
	if (typeof maxTokens === "number") {
		completeOptions.maxTokens = maxTokens;
	}

	const timed = startTimedCompactionSignal(args.signal, COMPACTION_TIMEOUT_MS);
	try {
		const response = await completeSimple(
			selected.model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [userMessage] },
			{ ...completeOptions, signal: timed.signal },
		);
		if (timed.didTimeout()) {
			throw new Error(`diligent-compact timed out after ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s`);
		}
		if (response.stopReason === "aborted" || args.signal.aborted) {
			throw new Error("Compaction cancelled");
		}
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "Opinionated compaction failed");
		}

		const summary = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim();
		if (!summary) {
			throw new Error("Opinionated compaction returned empty summary");
		}

		saveCompactionDebug(args.sessionId, {
			kind: "opinionated_success",
			provider: selected.model.provider,
			model: selected.model.id,
			thinkingLevel: selected.thinkingLevel,
			maxTokens,
			firstKeptEntryId: args.preparation.firstKeptEntryId,
			tokensBefore: args.preparation.tokensBefore,
			previousSummaryChars: previousSummary?.length ?? 0,
			conversationChars: conversationText.length,
			splitTurnPrefixChars: splitTurnPrefixText?.length ?? 0,
			customInstructionsPresent: Boolean(args.customInstructions),
			usage: response.usage,
			outputSummaryChars: summary.length,
		});

		return {
			summary,
			firstKeptEntryId: args.preparation.firstKeptEntryId,
			tokensBefore: args.preparation.tokensBefore,
			details: {
				provider: selected.model.provider,
				modelId: selected.model.id,
				thinkingLevel: selected.thinkingLevel,
				deltaMessages: args.preparation.messagesToSummarize.length,
				splitTurnPrefixMessages: args.preparation.turnPrefixMessages.length,
				usedPreviousSummary: Boolean(previousSummary && previousSummary.trim().length > 0),
			},
		};
	} catch (error) {
		if (timed.didTimeout()) {
			throw new Error(`diligent-compact timed out after ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s`);
		}
		throw error;
	} finally {
		timed.cleanup();
	}
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
		const diligentState = runtimeSnapshot?.state ?? loadStateFromEntries(branchEntries as SessionEntry[]);
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

		const visiblePreparation = buildVisiblePreparation(runtimeSnapshot, preparation, branchEntries);
		if (route === "force-native") {
			if (isVisiblePreparationFailure(visiblePreparation)) {
				const artifactPath = visiblePreparation.reason === "context-mapping-mismatch"
					? saveAlignmentDiagnostic({
						sessionId,
						route,
						blockedReason: visiblePreparation.reason,
						blockedMessage: visiblePreparation.message,
						diagnostic: visiblePreparation.diagnostic,
						snapshot: runtimeSnapshot,
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
					snapshot: runtimeSnapshot,
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
				? await runOpinionatedCompaction({
					ctx,
					preparation: visibleCompactionPreparation,
					customInstructions,
					signal,
					sessionId,
					fallbackThinkingLevel: pendingRequest?.fallbackThinkingLevel ?? CONFIG.thinkingLevel,
				})
				: await runCompatibilityCompaction({
					ctx,
					preparation: visibleCompactionPreparation,
					customInstructions,
					signal,
					sessionId,
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
