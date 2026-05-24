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

export type ConfigDiagnostic = {
	layer: string;
	code:
		| "missing-layer"
		| "read-error"
		| "invalid-json"
		| "invalid-config"
		| "invalid-compaction-model"
		| "ignored-compaction-models"
		| "invalid-thinking-level"
		| "invalid-debug-compactions";
	message: string;
	path?: string;
};

export type ExtensionConfigLayer = {
	name: string;
	path?: string;
	value?: unknown;
	text?: string | null;
	required?: boolean;
	error?: unknown;
};

export type LoadedExtensionConfig = {
	config: ExtensionConfig;
	diagnostics: ConfigDiagnostic[];
};

export type ModelAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
};

export type CurrentModelWithAuth = {
	model: Model<any>;
	auth: ModelAuth;
};

export type SelectedOpinionatedModel = {
	model: Model<any>;
	auth: ModelAuth;
	thinkingLevel: ThinkingLevel;
	source: "configured" | "current-model";
	configuredModel?: CompactionModelConfig;
};

export type SkippedConfiguredModel = {
	provider: string;
	id: string;
	reason: "not-registered" | "missing-auth" | "auth-error";
	message?: string;
};

export type OpinionatedModelSelectionResult = {
	selected: SelectedOpinionatedModel | null;
	skippedConfiguredModels: SkippedConfiguredModel[];
	configDiagnostics: ConfigDiagnostic[];
};

export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

/**
	* Backward-compatible shape for older tests/callers. Prefer CurrentModelWithAuth.
	*/
type CurrentModelWithApiKey = CurrentModelWithAuth & {
	apiKey?: string;
	headers?: Record<string, string>;
};

type ModelRegistryLike = {
	find?: (provider: string, id: string) => Promise<Model<any> | undefined | null> | Model<any> | undefined | null;
	getApiKeyAndHeaders?: (model: Model<any>) => Promise<unknown> | unknown;
	getApiKey?: (model: Model<any>) => Promise<string | undefined> | string | undefined;
	getApiKeyForProvider?: (provider: string) => Promise<string | undefined> | string | undefined;
	getAll?: () => Model<any>[];
	getAvailable?: () => Promise<Model<any>[]> | Model<any>[];
	authStorage?: {
		getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	};
};

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_CONFIG: ExtensionConfig = {
	compactionModels: [
		{ provider: "anthropic", id: "claude-opus-4-7", thinkingLevel: "xhigh" },
		{ provider: "openai-codex", id: "gpt-5.5", thinkingLevel: "xhigh" },
		{ provider: "openai-codex", id: "gpt-5.4", thinkingLevel: "xhigh" },
		{ provider: "anthropic", id: "claude-sonnet-4-6", thinkingLevel: "high" },
	],
	thinkingLevel: "xhigh",
	debugCompactions: false,
};

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");
const CONFIG_LOCAL_PATH = path.join(EXTENSION_DIR, "config.local.json");
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

function describeDiagnosticValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "object") return Array.isArray(value) ? "array" : "object";
	return String(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseLayerValue(layer: ExtensionConfigLayer, diagnostics: ConfigDiagnostic[]): unknown | undefined {
	if (layer.error !== undefined) {
		diagnostics.push({
			layer: layer.name,
			path: layer.path,
			code: "read-error",
			message: `Could not read ${layer.name}: ${errorMessage(layer.error)}`,
		});
		return undefined;
	}
	if (layer.value !== undefined) return layer.value;
	if (typeof layer.text === "string") {
		try {
			return JSON.parse(layer.text);
		} catch (error) {
			diagnostics.push({
				layer: layer.name,
				path: layer.path,
				code: "invalid-json",
				message: `Could not parse ${layer.name}: ${errorMessage(error)}`,
			});
			return undefined;
		}
	}
	if (layer.required) {
		diagnostics.push({
			layer: layer.name,
			path: layer.path,
			code: "missing-layer",
			message: `${layer.name} was not found; using lower-priority defaults`,
		});
	}
	return undefined;
}

function normalizeModelConfig(raw: unknown, layer: ExtensionConfigLayer, index: number, diagnostics: ConfigDiagnostic[]): CompactionModelConfig | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push({
			layer: layer.name,
			path: layer.path,
			code: "invalid-compaction-model",
			message: `${layer.name} compactionModels[${index}] must be an object with provider and id`,
		});
		return null;
	}
	const record = raw as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!provider || !id) {
		diagnostics.push({
			layer: layer.name,
			path: layer.path,
			code: "invalid-compaction-model",
			message: `${layer.name} compactionModels[${index}] must include non-empty string provider and id`,
		});
		return null;
	}

	const normalized: CompactionModelConfig = { provider, id };
	if (record.thinkingLevel !== undefined) {
		const thinkingLevel = normalizeThinkingLevel(record.thinkingLevel);
		if (thinkingLevel) {
			normalized.thinkingLevel = thinkingLevel;
		} else {
			diagnostics.push({
				layer: layer.name,
				path: layer.path,
				code: "invalid-thinking-level",
				message: `${layer.name} compactionModels[${index}].thinkingLevel ${describeDiagnosticValue(record.thinkingLevel)} is invalid and was ignored`,
			});
		}
	}
	return normalized;
}

function normalizeLayerConfig(
	previous: ExtensionConfig | null,
	layer: ExtensionConfigLayer,
	value: unknown,
	diagnostics: ConfigDiagnostic[],
): ExtensionConfig | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push({
			layer: layer.name,
			path: layer.path,
			code: "invalid-config",
			message: `${layer.name} must be a JSON object; got ${describeDiagnosticValue(value)}`,
		});
		return previous;
	}
	const record = value as Record<string, unknown>;
	const base = previous ?? DEFAULT_CONFIG;
	const next: ExtensionConfig = {
		compactionModels: base.compactionModels.map((model) => ({ ...model })),
		thinkingLevel: base.thinkingLevel,
		debugCompactions: base.debugCompactions,
	};

	if (Object.prototype.hasOwnProperty.call(record, "compactionModels")) {
		if (Array.isArray(record.compactionModels)) {
			if (record.compactionModels.length === 0) {
				next.compactionModels = [];
			} else {
				const validModels = record.compactionModels
					.map((model, index) => normalizeModelConfig(model, layer, index, diagnostics))
					.filter((model): model is CompactionModelConfig => Boolean(model));
				if (validModels.length > 0) {
					next.compactionModels = validModels;
				} else {
					diagnostics.push({
						layer: layer.name,
						path: layer.path,
						code: "ignored-compaction-models",
						message: `${layer.name} compactionModels contained no valid provider/id entries and was ignored`,
					});
				}
			}
		} else {
			diagnostics.push({
				layer: layer.name,
				path: layer.path,
				code: "ignored-compaction-models",
				message: `${layer.name} compactionModels must be an array and was ignored`,
			});
		}
	}

	if (Object.prototype.hasOwnProperty.call(record, "thinkingLevel")) {
		const thinkingLevel = normalizeThinkingLevel(record.thinkingLevel);
		if (thinkingLevel) {
			next.thinkingLevel = thinkingLevel;
		} else {
			diagnostics.push({
				layer: layer.name,
				path: layer.path,
				code: "invalid-thinking-level",
				message: `${layer.name} thinkingLevel ${describeDiagnosticValue(record.thinkingLevel)} is invalid and was ignored`,
			});
		}
	}

	if (Object.prototype.hasOwnProperty.call(record, "debugCompactions")) {
		if (typeof record.debugCompactions === "boolean") {
			next.debugCompactions = record.debugCompactions;
		} else {
			diagnostics.push({
				layer: layer.name,
				path: layer.path,
				code: "invalid-debug-compactions",
				message: `${layer.name} debugCompactions ${describeDiagnosticValue(record.debugCompactions)} is invalid and was ignored`,
			});
		}
	}

	return next;
}

export function loadExtensionConfigFromLayers(layers: ExtensionConfigLayer[]): LoadedExtensionConfig {
	const diagnostics: ConfigDiagnostic[] = [];
	let config: ExtensionConfig | null = null;
	for (const layer of layers) {
		const value = parseLayerValue(layer, diagnostics);
		if (value === undefined) continue;
		config = normalizeLayerConfig(config, layer, value, diagnostics) ?? config;
	}
	return {
		config: config ?? { ...DEFAULT_CONFIG, compactionModels: DEFAULT_CONFIG.compactionModels.map((model) => ({ ...model })) },
		diagnostics,
	};
}

function readConfigLayer(name: string, filePath: string, required: boolean): ExtensionConfigLayer {
	try {
		if (!existsSync(filePath)) {
			return { name, path: filePath, required };
		}
		return { name, path: filePath, text: readFileSync(filePath, "utf8"), required };
	} catch (error) {
		return { name, path: filePath, required, error };
	}
}

function loadRuntimeConfig(): LoadedExtensionConfig {
	return loadExtensionConfigFromLayers([
		{ name: "DEFAULT_CONFIG", value: DEFAULT_CONFIG, required: true },
		readConfigLayer("config.json", CONFIG_PATH, true),
		readConfigLayer("config.local.json", CONFIG_LOCAL_PATH, false),
	]);
}

export const CONFIG_LOAD_RESULT = loadRuntimeConfig();
export const CONFIG = CONFIG_LOAD_RESULT.config;
export const CONFIG_DIAGNOSTICS = CONFIG_LOAD_RESULT.diagnostics;

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

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		if (typeof key !== "string" || key.trim().length === 0) continue;
		if (typeof headerValue !== "string" || headerValue.trim().length === 0) continue;
		headers[key] = headerValue;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeAuth(value: unknown): ModelAuth | null {
	if (typeof value === "string") {
		return value.trim().length > 0 ? { apiKey: value } : null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const apiKey = typeof record.apiKey === "string" && record.apiKey.trim().length > 0 ? record.apiKey : undefined;
	const headers = normalizeHeaders(record.headers);
	return apiKey || headers ? { apiKey, headers } : null;
}

async function resolveAuthForModel(
	registry: ModelRegistryLike | undefined,
	model: Model<any>,
): Promise<{ auth: ModelAuth | null; error?: string }> {
	if (!registry) return { auth: null };
	if (typeof registry.getApiKeyAndHeaders === "function") {
		try {
			const result = await registry.getApiKeyAndHeaders(model);
			if (result && typeof result === "object" && !Array.isArray(result) && "ok" in result) {
				const record = result as Record<string, unknown>;
				if (record.ok === false) {
					return {
						auth: null,
						error: typeof record.message === "string"
							? record.message
							: typeof record.error === "string"
								? record.error
								: `Auth lookup failed for ${model.provider}/${model.id}`,
					};
				}
				if (record.ok === true) {
					return { auth: normalizeAuth(record) };
				}
			}
			return { auth: normalizeAuth(result) };
		} catch (error) {
			return { auth: null, error: errorMessage(error) };
		}
	}

	const legacyLookups: Array<() => Promise<string | undefined> | string | undefined> = [];
	if (typeof registry.getApiKey === "function") {
		legacyLookups.push(() => registry.getApiKey?.(model));
	}
	if (typeof registry.getApiKeyForProvider === "function") {
		legacyLookups.push(() => registry.getApiKeyForProvider?.(model.provider));
	}
	if (typeof registry.authStorage?.getApiKey === "function") {
		legacyLookups.push(() => registry.authStorage?.getApiKey?.(model.provider));
	}
	for (const lookup of legacyLookups) {
		try {
			const apiKey = await lookup();
			const auth = normalizeAuth(apiKey);
			if (auth) return { auth };
		} catch (error) {
			return { auth: null, error: errorMessage(error) };
		}
	}
	return { auth: null };
}

async function getRegisteredModels(registry: ModelRegistryLike | undefined): Promise<Model<any>[]> {
	if (!registry) return [];
	if (typeof registry.getAll === "function") {
		return registry.getAll();
	}
	if (typeof registry.getAvailable === "function") {
		const models = await registry.getAvailable();
		return Array.isArray(models) ? models : [];
	}
	return [];
}

async function findRegisteredModel(
	registry: ModelRegistryLike | undefined,
	provider: string,
	id: string,
): Promise<Model<any> | null> {
	if (!registry) return null;
	if (typeof registry.find === "function") {
		try {
			const found = await registry.find(provider, id);
			return found ?? null;
		} catch (error) {
			debugLog(`Model registry find(${provider}/${id}) failed: ${errorMessage(error)}`);
			return null;
		}
	}
	const registeredModels = await getRegisteredModels(registry);
	return registeredModels.find((model) => model.provider === provider && model.id === id) ?? null;
}

export async function getCurrentModelWithAuth(
	ctx: ExtensionContext,
): Promise<CurrentModelWithAuth | null> {
	if (!ctx.model) return null;
	const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
	const authResult = await resolveAuthForModel(registry, ctx.model);
	if (authResult.error) {
		debugLog(`Auth lookup for current model ${ctx.model.provider}/${ctx.model.id} failed: ${authResult.error}`);
		return null;
	}
	if (!authResult.auth) return null;
	return { model: ctx.model, auth: authResult.auth };
}

export async function getCurrentModelWithApiKey(
	ctx: ExtensionContext,
): Promise<CurrentModelWithApiKey | null> {
	const current = await getCurrentModelWithAuth(ctx);
	if (!current?.auth.apiKey) return null;
	return {
		...current,
		apiKey: current.auth.apiKey,
		headers: current.auth.headers,
	};
}

export async function selectOpinionatedModel(
	ctx: ExtensionContext,
	fallbackThinkingLevel: ThinkingLevel,
	loadedConfig: LoadedExtensionConfig = CONFIG_LOAD_RESULT,
): Promise<OpinionatedModelSelectionResult> {
	const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
	const skippedConfiguredModels: SkippedConfiguredModel[] = [];
	for (const cfg of loadedConfig.config.compactionModels) {
		const registryModel = await findRegisteredModel(registry, cfg.provider, cfg.id);
		if (!registryModel) {
			debugLog(`Model ${cfg.provider}/${cfg.id} not registered`);
			skippedConfiguredModels.push({ provider: cfg.provider, id: cfg.id, reason: "not-registered" });
			continue;
		}
		const authResult = await resolveAuthForModel(registry, registryModel);
		if (authResult.error) {
			debugLog(`Auth lookup for ${cfg.provider}/${cfg.id} failed: ${authResult.error}`);
			skippedConfiguredModels.push({
				provider: cfg.provider,
				id: cfg.id,
				reason: "auth-error",
				message: authResult.error,
			});
			continue;
		}
		if (!authResult.auth) {
			debugLog(`No API key or request headers for ${cfg.provider}/${cfg.id}`);
			skippedConfiguredModels.push({ provider: cfg.provider, id: cfg.id, reason: "missing-auth" });
			continue;
		}
		return {
			selected: {
				model: registryModel,
				auth: authResult.auth,
				thinkingLevel: cfg.thinkingLevel ?? loadedConfig.config.thinkingLevel,
				source: "configured",
				configuredModel: { ...cfg },
			},
			skippedConfiguredModels,
			configDiagnostics: loadedConfig.diagnostics,
		};
	}

	const current = await getCurrentModelWithAuth(ctx);
	if (!current) {
		return {
			selected: null,
			skippedConfiguredModels,
			configDiagnostics: loadedConfig.diagnostics,
		};
	}
	return {
		selected: {
			model: current.model,
			auth: current.auth,
			thinkingLevel: fallbackThinkingLevel,
			source: "current-model",
		},
		skippedConfiguredModels,
		configDiagnostics: loadedConfig.diagnostics,
	};
}

function summarizeConfigDiagnostics(diagnostics: ConfigDiagnostic[], limit: number = 2): string {
	const shown = diagnostics.slice(0, limit).map((diagnostic) => `${diagnostic.layer}: ${diagnostic.message}`);
	const remaining = diagnostics.length - shown.length;
	return remaining > 0 ? `${shown.join("; ")}; ${remaining} more` : shown.join("; ");
}

function summarizeSkippedModels(skipped: SkippedConfiguredModel[], limit: number = 3): string {
	const shown = skipped.slice(0, limit).map((model) => {
		const reason = model.message ? `${model.reason} (${model.message})` : model.reason;
		return `${model.provider}/${model.id}: ${reason}`;
	});
	const remaining = skipped.length - shown.length;
	return remaining > 0 ? `${shown.join("; ")}; ${remaining} more` : shown.join("; ");
}

export function buildSelectionDiagnosticsWarning(
	operation: string,
	selection: OpinionatedModelSelectionResult,
): string | null {
	const parts: string[] = [];
	if (selection.configDiagnostics.length > 0) {
		parts.push(`config warnings: ${summarizeConfigDiagnostics(selection.configDiagnostics)}`);
	}
	if (selection.selected?.source === "current-model" && selection.skippedConfiguredModels.length > 0) {
		parts.push(
			`using current session model ${selection.selected.model.provider}/${selection.selected.model.id} after skipping configured candidates (${summarizeSkippedModels(selection.skippedConfiguredModels)})`,
		);
	}
	if (parts.length === 0) return null;
	return `${operation}: ${parts.join("; ")}`;
}

export function emitSelectionDiagnosticsWarning(
	operation: string,
	selection: OpinionatedModelSelectionResult,
	notify?: (text: string, level?: NotifyLevel) => void,
): void {
	const warning = buildSelectionDiagnosticsWarning(operation, selection);
	if (!warning) return;
	if (notify) {
		notify(warning, "warning");
		return;
	}
	debugLog(warning);
}

export async function runCompatibilityCompactionRequest(args: {
	ctx: ExtensionContext;
	preparation: CompactionPreparation;
	customInstructions?: string;
	signal: AbortSignal;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	promptEstimateText: string;
	onDebug?: (payload: unknown) => void;
}): Promise<CompactionResult> {
	const modelWithAuth = await getCurrentModelWithAuth(args.ctx);
	if (!modelWithAuth) {
		throw new Error("No current model auth available for compatibility compaction");
	}

	const reserveTokens = args.preparation.settings?.reserveTokens;
	const historyMaxTokens = (typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens > 0)
		? Math.floor(0.8 * reserveTokens)
		: undefined;
	if (args.preparation.messagesToSummarize.length > 0) {
		assertPromptFitsBudget({
			label: "compatibility compaction",
			model: modelWithAuth.model,
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
			model: modelWithAuth.model,
			systemPrompt: args.systemPrompt,
			promptText: splitPromptText,
			maxTokens: typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens > 0
				? Math.floor(0.5 * reserveTokens)
				: undefined,
			extraOverheadTokens: 1024,
		});
	}

	debugLog(
		`route=compatibility provider=${modelWithAuth.model.provider} model=${modelWithAuth.model.id} delta=${args.preparation.messagesToSummarize.length} prefix=${args.preparation.turnPrefixMessages.length}`,
	);

	const timed = startTimedCompactionSignal(args.signal, COMPACTION_TIMEOUT_MS);
	try {
		const result = await runNativeCompact(
			args.preparation,
			modelWithAuth.model,
			modelWithAuth.auth.apiKey,
			modelWithAuth.auth.headers,
			args.customInstructions,
			timed.signal,
			args.thinkingLevel,
		);
		if (timed.didTimeout()) {
			throw new Error(`compatibility compaction timed out after ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s`);
		}
		args.onDebug?.({
			kind: "compatibility_success",
			provider: modelWithAuth.model.provider,
			model: modelWithAuth.model.id,
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
	loadedConfig?: LoadedExtensionConfig;
	notify?: (text: string, level?: NotifyLevel) => void;
	onDebug?: (payload: unknown) => void;
}): Promise<CompactionResult> {
	const selection = await selectOpinionatedModel(args.ctx, args.fallbackThinkingLevel, args.loadedConfig);
	emitSelectionDiagnosticsWarning("diligent-compact", selection, args.notify);
	const selected = selection.selected;
	if (!selected) {
		throw new Error("No model auth available for opinionated compaction");
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
		apiKey?: string;
		headers?: Record<string, string>;
		signal: AbortSignal;
		reasoning?: ThinkingLevel;
		maxTokens?: number;
	} = {
		...selected.auth,
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
			modelSource: selected.source,
			configuredModel: selected.configuredModel,
			thinkingLevel: selected.thinkingLevel,
			maxTokens,
			firstKeptEntryId: args.preparation.firstKeptEntryId,
			tokensBefore: args.preparation.tokensBefore,
			previousSummaryChars: previousSummary?.length ?? 0,
			conversationChars: conversationText.length,
			splitTurnPrefixChars: splitTurnPrefixText?.length ?? 0,
			customInstructionsPresent: Boolean(args.customInstructions),
			skippedConfiguredModels: selection.skippedConfiguredModels,
			configDiagnostics: selection.configDiagnostics,
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
				modelSource: selected.source,
				configuredModel: selected.configuredModel,
				thinkingLevel: selected.thinkingLevel,
				deltaMessages: args.preparation.messagesToSummarize.length,
				splitTurnPrefixMessages: args.preparation.turnPrefixMessages.length,
				usedPreviousSummary: Boolean(previousSummary && previousSummary.trim().length > 0),
				skippedConfiguredModels: selection.skippedConfiguredModels,
				configDiagnostics: selection.configDiagnostics,
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
