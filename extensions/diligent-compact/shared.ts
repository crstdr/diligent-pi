import { completeSimple, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
	compact as runNativeCompact,
	convertToLlm,
	estimateTokens,
	serializeConversation,
	type CompactionResult,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type NotifyLevel = "info" | "warning" | "error";

export type CompactionModelConfig = {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
};

export type ExtensionConfig = {
	compactionModels: CompactionModelConfig[];
	thinkingLevel: ThinkingLevel;
	debugCompactions: boolean;
};

export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

type CurrentModelWithApiKey = {
	model: Model<any>;
	apiKey: string;
};

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
const COMPACTIONS_DIR = path.join(homedir(), ".pi", "agent", "extensions", "diligent-compact", "compactions");

export const COMPACTION_TIMEOUT_MS = 180_000;

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `~${tokens} tokens`;
	return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

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

export const CONFIG = loadConfig();

export function debugLog(message: string): void {
	if (!CONFIG.debugCompactions) return;
	try {
		mkdirSync(COMPACTIONS_DIR, { recursive: true });
		appendFileSync(path.join(COMPACTIONS_DIR, "debug.log"), `[${new Date().toISOString()}] ${message}\n`);
	} catch {
		// ignore
	}
}

export function readOptionalTextFile(filePath: string, fallback: string): string {
	try {
		if (existsSync(filePath)) {
			const text = readFileSync(filePath, "utf8").trim();
			if (text.length > 0) return text;
		}
	} catch {
		// fall back
	}
	return fallback;
}

export function buildTaggedPromptText(
	blocks: Array<{
		tag?: string;
		text?: string | null;
	}>,
): string {
	return blocks
		.map((block) => {
			const text = block.text?.trim();
			if (!text) return null;
			return block.tag ? `<${block.tag}>\n${text}\n</${block.tag}>` : text;
		})
		.filter((block): block is string => typeof block === "string" && block.length > 0)
		.join("\n\n")
		.trim();
}

export function startTimedCompactionSignal(parent: AbortSignal, timeoutMs: number): {
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

export function assertPromptFitsBudget(args: {
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

export async function getCurrentModelWithApiKey(
	ctx: ExtensionContext,
): Promise<CurrentModelWithApiKey | null> {
	if (!ctx.model) return null;
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;
	return { model: ctx.model, apiKey };
}

export async function selectOpinionatedModel(
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

export async function runCompatibilityCompactionRequest(args: {
	ctx: ExtensionContext;
	preparation: CompactionPreparation;
	customInstructions?: string;
	signal: AbortSignal;
	systemPrompt: string;
	promptEstimateText: string;
	onDebug?: (payload: unknown) => void;
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
		assertPromptFitsBudget({
			label: "compatibility compaction",
			model: modelWithKey.model,
			systemPrompt: args.systemPrompt,
			promptText: args.promptEstimateText,
			maxTokens: historyMaxTokens,
			extraOverheadTokens: 1536,
		});
	}
	if (args.preparation.isSplitTurn && args.preparation.turnPrefixMessages.length > 0) {
		const splitPromptText = buildTaggedPromptText([
			{
				tag: "conversation",
				text: serializeConversation(convertToLlm(args.preparation.turnPrefixMessages)),
			},
			{ text: "Summarize only the retained turn prefix context." },
		]);
		assertPromptFitsBudget({
			label: "compatibility split-turn compaction",
			model: modelWithKey.model,
			systemPrompt: args.systemPrompt,
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
		args.onDebug?.({
			kind: "compatibility_success",
			provider: modelWithKey.model.provider,
			model: modelWithKey.model.id,
			messagesToSummarizeCount: args.preparation.messagesToSummarize.length,
			turnPrefixMessagesCount: args.preparation.turnPrefixMessages.length,
			usedPreviousSummary: Boolean(args.preparation.previousSummary),
			customInstructionsPresent: Boolean(args.customInstructions),
			outputSummaryChars: result.summary.length,
		});
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

export async function runOpinionatedCompactionRequest(args: {
	ctx: ExtensionContext;
	preparation: CompactionPreparation;
	promptText: string;
	systemPrompt: string;
	customInstructions?: string;
	signal: AbortSignal;
	fallbackThinkingLevel: ThinkingLevel;
	notify?: (text: string, level?: NotifyLevel) => void;
	onDebug?: (payload: unknown) => void;
}): Promise<CompactionResult> {
	const selected = await selectOpinionatedModel(args.ctx, args.fallbackThinkingLevel);
	if (!selected) {
		throw new Error("No model/API key available for opinionated compaction");
	}

	const reserveTokens = args.preparation.settings?.reserveTokens;
	const maxTokens = (typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens > 0)
		? Math.floor(0.8 * reserveTokens)
		: undefined;
	assertPromptFitsBudget({
		label: "diligent-compact",
		model: selected.model,
		systemPrompt: args.systemPrompt,
		promptText: args.promptText,
		maxTokens,
		extraOverheadTokens: 512,
	});

	args.notify?.(
		`diligent-compact: compacting ${args.preparation.messagesToSummarize.length} visible messages with ${selected.model.provider}/${selected.model.id} (thinking: ${selected.thinkingLevel})`,
		"info",
	);

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: args.promptText }],
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
			{ systemPrompt: args.systemPrompt, messages: [userMessage] },
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

		const conversationText = serializeConversation(convertToLlm(args.preparation.messagesToSummarize));
		const splitTurnPrefixText = (args.preparation.isSplitTurn && args.preparation.turnPrefixMessages.length > 0)
			? serializeConversation(convertToLlm(args.preparation.turnPrefixMessages))
			: undefined;
		const previousSummary = typeof args.preparation.previousSummary === "string"
			? args.preparation.previousSummary
			: undefined;
		args.onDebug?.({
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
