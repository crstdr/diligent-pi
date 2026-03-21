import type { Model, UserMessage } from "@mariozechner/pi-ai";
import { estimateTokens, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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

function formatTokens(tokens: number): string {
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

async function getCurrentModelWithApiKey(
	ctx: ExtensionContext,
): Promise<{ model: Model<any>; apiKey: string } | null> {
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
