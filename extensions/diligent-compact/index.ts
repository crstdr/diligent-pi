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
	applyPruningAtBoundary,
	computePayloadFingerprint,
	diligentContextRuntime,
	formatTokens,
	getToolCallBlockIds,
	getToolResultId,
	type EventMessage,
} from "../diligent-context/core.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type CompactionRoute = "native" | "compatibility" | "opinionated";
type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type PendingOpinionatedRequest = {
	expiresAt: number;
	nonce: number;
	fallbackThinkingLevel: ThinkingLevel;
};

type DiligentCompactionDetails = {
	diligentContextAnchorSignature?: string;
	diligentContextSummarySafe?: boolean;
	route?: Exclude<CompactionRoute, "native">;
	[key: string]: unknown;
};

type SegmentedMessage = EventMessage & {
	__diligentSegment?: "prefix" | "delta";
};

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const OPINIONATED_REQUEST_TTL_MS = 2_000;
const COMPACTION_TIMEOUT_MS = 180_000;
const COMPACTION_STATUS_KEY = "diligent-compact";
const COMPACTION_SUMMARY_WIDGET_KEY = "diligent-compact-summary";

const pendingOpinionatedRequests = new Map<string, PendingOpinionatedRequest>();
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

const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. " +
	"Do NOT continue the conversation. " +
	"Do NOT answer any questions in the conversation. " +
	"ONLY output the structured summary requested by the user prompt.";

const DEFAULT_PROMPT_BODY =
	"Output ONLY markdown. Keep it concise. Use the exact format requested in the user prompt.";
const VISIBILITY_RESET_SUMMARY = "Older hidden context omitted by diligent-context.";

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

function sameStringArray(a: string[] | null, b: string[] | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

function getSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId?.() ?? "unknown-session";
}

function clearPendingOpinionatedRequest(sessionId: string, nonce?: number): void {
	const request = pendingOpinionatedRequests.get(sessionId);
	if (!request) return;
	if (nonce !== undefined && request.nonce !== nonce) return;
	pendingOpinionatedRequests.delete(sessionId);
}

function armPendingOpinionatedRequest(
	ctx: ExtensionCommandContext,
	fallbackThinkingLevel: ThinkingLevel,
): { sessionId: string; nonce: number } {
	const sessionId = getSessionId(ctx);
	const nonce = nextOpinionatedRequestNonce++;
	pendingOpinionatedRequests.set(sessionId, {
		expiresAt: Date.now() + OPINIONATED_REQUEST_TTL_MS,
		nonce,
		fallbackThinkingLevel,
	});
	return { sessionId, nonce };
}

function isPendingOpinionatedRequest(sessionId: string, nonce: number): boolean {
	return pendingOpinionatedRequests.get(sessionId)?.nonce === nonce;
}

function consumeOpinionatedRequest(ctx: ExtensionContext): PendingOpinionatedRequest | null {
	const sessionId = getSessionId(ctx);
	const request = pendingOpinionatedRequests.get(sessionId);
	if (!request) return null;
	if (request.expiresAt < Date.now()) {
		pendingOpinionatedRequests.delete(sessionId);
		return null;
	}
	pendingOpinionatedRequests.delete(sessionId);
	return request;
}

function findUniqueFullPayloadIndex(message: EventMessage, fullPayload: EventMessage[]): number | null {
	const fingerprint = computePayloadFingerprint(message, 0);
	const matches: number[] = [];
	for (let i = 0; i < fullPayload.length; i++) {
		const candidate = computePayloadFingerprint(fullPayload[i], i);
		if (candidate.role !== fingerprint.role) continue;
		if (candidate.textPrefix !== fingerprint.textPrefix) continue;
		if (!sameStringArray(candidate.toolNames, fingerprint.toolNames)) continue;
		if (candidate.toolCount !== fingerprint.toolCount) continue;
		matches.push(i);
	}
	return matches.length === 1 ? matches[0] : null;
}

function filterCombinedWithGlobalIds(
	messages: SegmentedMessage[],
	payloadPruneIds: Set<string>,
	protectedIds: Set<string>,
): { filteredMessages: SegmentedMessage[]; changed: boolean } {
	let changed = false;
	const filteredMessages: SegmentedMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			const id = getToolResultId(msg);
			if (id && payloadPruneIds.has(id) && !protectedIds.has(id)) {
				changed = true;
				continue;
			}
			filteredMessages.push(msg);
			continue;
		}
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const nextContent = msg.content.filter((block) => {
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
			continue;
		}
		filteredMessages.push(msg);
	}
	return { filteredMessages, changed };
}

function filterVisibleSlices(
	turnPrefixMessages: EventMessage[],
	messagesToSummarize: EventMessage[],
): {
	visibleTurnPrefixMessages: EventMessage[];
	visibleMessagesToSummarize: EventMessage[];
	changed: boolean;
	proof: "before-anchor" | "after-anchor" | "mixed-anchor" | "unproven";
} {
	const snapshot = diligentContextRuntime.snapshot;
	if (!snapshot || !snapshot.state.enabled || snapshot.state.anchorMode === "pending-here" || snapshot.resolvedAnchorIndex === null || !snapshot.rawMessages) {
		return { visibleTurnPrefixMessages: turnPrefixMessages, visibleMessagesToSummarize: messagesToSummarize, changed: false, proof: "unproven" };
	}
	const combined: SegmentedMessage[] = [
		...messagesToSummarize.map((message) => ({ ...message, __diligentSegment: "delta" as const })),
		...turnPrefixMessages.map((message) => ({ ...message, __diligentSegment: "prefix" as const })),
	];
	if (combined.length === 0) {
		return { visibleTurnPrefixMessages: turnPrefixMessages, visibleMessagesToSummarize: messagesToSummarize, changed: false, proof: "unproven" };
	}
	const firstIndex = findUniqueFullPayloadIndex(combined[0], snapshot.rawMessages);
	const lastIndex = findUniqueFullPayloadIndex(combined[combined.length - 1], snapshot.rawMessages);
	if (firstIndex === null || lastIndex === null || firstIndex > lastIndex) {
		return { visibleTurnPrefixMessages: turnPrefixMessages, visibleMessagesToSummarize: messagesToSummarize, changed: false, proof: "unproven" };
	}
	const anchorIndex = snapshot.resolvedAnchorIndex;
	const isEntireSliceBeforeAnchor = snapshot.state.anchorMode === "after-entry"
		? lastIndex <= anchorIndex
		: lastIndex < anchorIndex;
	const isEntireSliceAfterAnchor = snapshot.state.anchorMode === "after-entry"
		? firstIndex > anchorIndex
		: firstIndex >= anchorIndex;
	if (isEntireSliceAfterAnchor) {
		return { visibleTurnPrefixMessages: turnPrefixMessages, visibleMessagesToSummarize: messagesToSummarize, changed: false, proof: "after-anchor" };
	}
	const proof = isEntireSliceBeforeAnchor ? "before-anchor" : "mixed-anchor";
	const globalPruneResult = applyPruningAtBoundary(
		snapshot.rawMessages,
		anchorIndex,
		snapshot.state.anchorMode ?? "from-entry",
	);
	const localFilterResult = filterCombinedWithGlobalIds(
		combined,
		globalPruneResult.payloadPruneIds,
		globalPruneResult.protectedIds,
	);
	const visibleTurnPrefixMessages: EventMessage[] = [];
	const visibleMessagesToSummarize: EventMessage[] = [];
	for (const message of localFilterResult.filteredMessages) {
		const segment = message.__diligentSegment;
		const cleanMessage = { ...message };
		delete cleanMessage.__diligentSegment;
		if (segment === "prefix") {
			visibleTurnPrefixMessages.push(cleanMessage);
		} else {
			visibleMessagesToSummarize.push(cleanMessage);
		}
	}
	return {
		visibleTurnPrefixMessages,
		visibleMessagesToSummarize,
		changed: localFilterResult.changed,
		proof,
	};
}

function getCurrentAnchorSignature(): string | null {
	const snapshot = diligentContextRuntime.snapshot;
	if (!snapshot || !snapshot.state.enabled || snapshot.state.anchorMode === "pending-here" || snapshot.resolvedAnchorIndex === null || !snapshot.state.anchorFingerprint) {
		return null;
	}
	return JSON.stringify({
		anchorMode: snapshot.state.anchorMode,
		anchorFingerprint: snapshot.state.anchorFingerprint,
	});
}

function getLastCompactionDetails(branchEntries: SessionBeforeCompactEvent["branchEntries"]): DiligentCompactionDetails | null {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as { type?: string; details?: unknown };
		if (entry.type !== "compaction") continue;
		if (!entry.details || typeof entry.details !== "object" || Array.isArray(entry.details)) return null;
		return entry.details as DiligentCompactionDetails;
	}
	return null;
}

function isPreviousSummarySafeForCurrentAnchor(
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
	anchorSignature: string | null,
): boolean {
	if (!anchorSignature) return false;
	const details = getLastCompactionDetails(branchEntries);
	return details?.diligentContextSummarySafe === true && details.diligentContextAnchorSignature === anchorSignature;
}

function buildFilteredPreparation(
	preparation: CompactionPreparation,
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
): {
	filteredPreparation: CompactionPreparation;
	visibilityChanged: boolean;
	summaryResetRequired: boolean;
	anchorSignature: string | null;
	proof: "before-anchor" | "after-anchor" | "mixed-anchor" | "unproven";
} {
	// Cast: Pi's compaction preparation message types are broader than the payload-grounded
	// diligent-context helpers, but the fields we read overlap safely.
	const messagesToSummarize = preparation.messagesToSummarize as EventMessage[];
	const turnPrefixMessages = preparation.turnPrefixMessages as EventMessage[];
	const { visibleMessagesToSummarize, visibleTurnPrefixMessages, changed, proof } = filterVisibleSlices(
		turnPrefixMessages,
		messagesToSummarize,
	);
	const anchorSignature = getCurrentAnchorSignature();
	const summaryResetRequired = Boolean(
		anchorSignature &&
			typeof preparation.previousSummary === "string" &&
			preparation.previousSummary.trim().length > 0 &&
			!isPreviousSummarySafeForCurrentAnchor(branchEntries, anchorSignature),
	);
	return {
		filteredPreparation: {
			...preparation,
			previousSummary: summaryResetRequired ? undefined : preparation.previousSummary,
			messagesToSummarize: visibleMessagesToSummarize,
			turnPrefixMessages: visibleTurnPrefixMessages,
		},
		visibilityChanged: changed,
		summaryResetRequired,
		anchorSignature,
		proof,
	};
}

function attachDiligentDetails(
	result: CompactionResult,
	route: Exclude<CompactionRoute, "native">,
	anchorSignature: string | null,
	summarySafe: boolean,
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
			diligentContextSummarySafe: summarySafe,
		},
	};
}

function buildVisibleSummaryCarryForwardCompaction(
	preparation: CompactionPreparation,
	route: Exclude<CompactionRoute, "native">,
	anchorSignature: string | null,
	summarySafe: boolean,
): CompactionResult {
	const priorSummary = typeof preparation.previousSummary === "string" && preparation.previousSummary.trim().length > 0
		? preparation.previousSummary
		: VISIBILITY_RESET_SUMMARY;
	return attachDiligentDetails(
		{
			summary: priorSummary,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		},
		route,
		anchorSignature,
		summarySafe,
	);
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
		`diligent-compact: compacting ${args.preparation.messagesToSummarize.length} visible messages` +
			(isSplitTurn && args.preparation.turnPrefixMessages.length > 0
				? ` (+${args.preparation.turnPrefixMessages.length} visible split-turn prefix)`
				: "") +
			` with ${selected.model.provider}/${selected.model.id} (thinking: ${selected.thinkingLevel})`,
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
		description: "Run opinionated visibility-aware compaction. Usage: /diligent-compact [instructions]",
		handler: async (args, ctx) => {
			const { sessionId, nonce } = armPendingOpinionatedRequest(ctx, pi.getThinkingLevel());
			clearCompactionSummaryWidget(ctx);
			setCompactionStatus(ctx, "diligent-compact: running");
			try {
				ctx.compact({
					customInstructions: args.trim() || undefined,
					onComplete: (result) => {
						clearPendingOpinionatedRequest(sessionId, nonce);
						setCompactionStatus(ctx, undefined);
						notify(
							ctx,
							`diligent-compact complete: visible context checkpoint saved (${formatTokens(result.tokensBefore)} before compaction)`,
							"info",
						);
					},
					onError: (error) => {
						const shouldNotify = isPendingOpinionatedRequest(sessionId, nonce);
						clearPendingOpinionatedRequest(sessionId, nonce);
						setCompactionStatus(ctx, undefined);
						if (!shouldNotify) return;
						const message = error instanceof Error ? error.message : String(error);
						if (message === "Compaction cancelled") return;
						notify(ctx, `diligent-compact failed: ${message}`, "warning");
					},
				});
			} catch (error) {
				clearPendingOpinionatedRequest(sessionId, nonce);
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
		const sessionId = getSessionId(ctx);
		const { filteredPreparation, visibilityChanged, summaryResetRequired, anchorSignature, proof } = buildFilteredPreparation(preparation, branchEntries);
		const opinionatedRequest = consumeOpinionatedRequest(ctx);
		const route: CompactionRoute = opinionatedRequest
			? "opinionated"
			: anchorSignature !== null
				? "compatibility"
				: "native";

		debugLog(
			`route=${route} proof=${proof} visibilityChanged=${visibilityChanged} summaryResetRequired=${summaryResetRequired} anchorActive=${anchorSignature !== null} delta=${preparation.messagesToSummarize.length}->${filteredPreparation.messagesToSummarize.length} prefix=${preparation.turnPrefixMessages.length}->${filteredPreparation.turnPrefixMessages.length}`,
		);

		if (signal.aborted) {
			debugLog("Compaction aborted before start");
			return { cancel: true };
		}

		if (route === "native") {
			return undefined;
		}
		if (anchorSignature !== null && proof === "unproven") {
			notify(
				ctx,
				route === "opinionated"
					? "diligent-compact blocked: the current diligent-context boundary could not be proven safely for this compaction slice"
					: "/compact blocked: the current diligent-context boundary could not be proven safely for this compaction slice",
				"warning",
			);
			return { cancel: true };
		}

		if (
			filteredPreparation.messagesToSummarize.length === 0 &&
			filteredPreparation.turnPrefixMessages.length === 0
		) {
			if (summaryResetRequired) {
				notify(ctx, "diligent-compact: resetting stale pre-anchor summary to keep hidden context out of future compactions", "info");
			} else if (route === "compatibility") {
				notify(ctx, "diligent-compact: carrying forward the existing visible summary while compacting hidden-only context", "info");
			}
			return {
				compaction: buildVisibleSummaryCarryForwardCompaction(
					filteredPreparation,
					route,
					anchorSignature,
					proof !== "unproven",
				),
			};
		}

		try {
			const result = route === "opinionated"
				? await runOpinionatedCompaction({
					ctx,
					preparation: filteredPreparation,
					customInstructions,
					signal,
					sessionId,
					fallbackThinkingLevel: opinionatedRequest?.fallbackThinkingLevel ?? CONFIG.thinkingLevel,
				})
				: await runCompatibilityCompaction({
					ctx,
					preparation: filteredPreparation,
					customInstructions,
					signal,
					sessionId,
				});

			return { compaction: attachDiligentDetails(result, route, anchorSignature, proof !== "unproven") };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (signal.aborted || message === "Compaction cancelled") {
				return { cancel: true };
			}
			if (route === "compatibility") {
				notify(
					ctx,
					`/compact blocked: visibility-aware compaction failed (${message}). Hidden context was preserved.`,
					"warning",
				);
				saveCompactionDebug(sessionId, {
					kind: "compatibility_error",
					error: message,
					messagesToSummarizeCount: filteredPreparation.messagesToSummarize.length,
					turnPrefixMessagesCount: filteredPreparation.turnPrefixMessages.length,
					customInstructionsPresent: Boolean(customInstructions),
				});
				return { cancel: true };
			}

			notify(ctx, `diligent-compact failed: ${message}`, "warning");
			saveCompactionDebug(sessionId, {
				kind: "opinionated_error",
				error: message,
				messagesToSummarizeCount: filteredPreparation.messagesToSummarize.length,
				turnPrefixMessagesCount: filteredPreparation.turnPrefixMessages.length,
				customInstructionsPresent: Boolean(customInstructions),
			});
			return { cancel: true };
		}
	});
}
