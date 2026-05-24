import { beforeEach, describe, expect, mock, test } from "bun:test";

const completeSimpleCalls: unknown[][] = [];
const nativeCompactCalls: unknown[][] = [];

mock.module("@mariozechner/pi-ai", () => ({
	completeSimple: async (...args: unknown[]) => {
		completeSimpleCalls.push(args);
		return {
			stopReason: "stop",
			content: [{ type: "text", text: "generated summary" }],
			usage: { inputTokens: 10, outputTokens: 4 },
		};
	},
}));

mock.module("@mariozechner/pi-coding-agent", () => ({
	DynamicBorder: class DynamicBorder {
		constructor(_render: unknown) {}
	},
	CompactionSummaryMessageComponent: class CompactionSummaryMessageComponent {
		constructor(..._args: unknown[]) {}
		setExpanded(_value: boolean) {}
	},
	compact: async (...args: unknown[]) => {
		nativeCompactCalls.push(args);
		const preparation = args[0] as any;
		return {
			summary: "native summary",
			firstKeptEntryId: preparation?.firstKeptEntryId ?? "entry-1",
			tokensBefore: preparation?.tokensBefore ?? 0,
			details: {},
		};
	},
	convertToLlm: (value: unknown) => value,
	getMarkdownTheme: () => ({}),
	serializeConversation: (value: unknown) => JSON.stringify(value),
	estimateTokens(value: unknown) {
		return Math.ceil(JSON.stringify(value).length / 4);
	},
}));

const shared = await import("../extensions/diligent-compact/shared.ts");

function model(provider: string, id: string): any {
	return { provider, id, contextWindow: 128000 };
}

function loadedConfig(
	compactionModels: Array<{ provider: string; id: string; thinkingLevel?: shared.ThinkingLevel }>,
	diagnostics: shared.ConfigDiagnostic[] = [],
): shared.LoadedExtensionConfig {
	return {
		config: {
			compactionModels,
			thinkingLevel: "medium",
			debugCompactions: false,
		},
		diagnostics,
	};
}

function makePreparation(overrides: Record<string, unknown> = {}): any {
	return {
		messagesToSummarize: [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		firstKeptEntryId: "entry-1",
		tokensBefore: 1234,
		settings: { reserveTokens: 12000 },
		...overrides,
	};
}

beforeEach(() => {
	completeSimpleCalls.length = 0;
	nativeCompactCalls.length = 0;
});

describe("diligent-compact/shared config loading", () => {
	test("DEFAULT_CONFIG uses the committed candidate order and thinking levels", () => {
		const result = shared.loadExtensionConfigFromLayers([
			{ name: "DEFAULT_CONFIG", value: shared.DEFAULT_CONFIG, required: true },
		]);

		expect(result.diagnostics).toEqual([]);
		expect(result.config.compactionModels).toEqual([
			{ provider: "anthropic", id: "claude-opus-4-7", thinkingLevel: "xhigh" },
			{ provider: "openai-codex", id: "gpt-5.5", thinkingLevel: "xhigh" },
			{ provider: "openai-codex", id: "gpt-5.4", thinkingLevel: "xhigh" },
			{ provider: "anthropic", id: "claude-sonnet-4-6", thinkingLevel: "high" },
		]);
		expect(result.config.thinkingLevel).toBe("xhigh");
		expect(result.config.debugCompactions).toBe(false);
	});

	test("layers inherit missing fields and local compactionModels can intentionally disable configured candidates", () => {
		const result = shared.loadExtensionConfigFromLayers([
			{
				name: "DEFAULT_CONFIG",
				value: {
					compactionModels: [{ provider: "default", id: "model", thinkingLevel: "low" }],
					thinkingLevel: "low",
					debugCompactions: false,
				},
				required: true,
			},
			{
				name: "config.json",
				value: {
					thinkingLevel: "high",
					debugCompactions: true,
				},
				required: true,
			},
			{
				name: "config.local.json",
				value: {
					compactionModels: [],
				},
			},
		]);

		expect(result.config.compactionModels).toEqual([]);
		expect(result.config.thinkingLevel).toBe("high");
		expect(result.config.debugCompactions).toBe(true);
		expect(result.diagnostics).toEqual([]);
	});

	test("invalid config JSON and invalid local overrides warn and keep prior valid values", () => {
		const result = shared.loadExtensionConfigFromLayers([
			{
				name: "DEFAULT_CONFIG",
				value: {
					compactionModels: [{ provider: "default", id: "model", thinkingLevel: "medium" }],
					thinkingLevel: "medium",
					debugCompactions: false,
				},
				required: true,
			},
			{
				name: "config.json",
				text: "{",
				required: true,
			},
			{
				name: "config.local.json",
				value: {
					compactionModels: [{ provider: 123, id: null }],
					thinkingLevel: "turbo",
					debugCompactions: "yes",
				},
			},
		]);

		expect(result.config.compactionModels).toEqual([
			{ provider: "default", id: "model", thinkingLevel: "medium" },
		]);
		expect(result.config.thinkingLevel).toBe("medium");
		expect(result.config.debugCompactions).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"invalid-json",
			"invalid-compaction-model",
			"ignored-compaction-models",
			"invalid-thinking-level",
			"invalid-debug-compactions",
		]);
	});

	test("a non-empty compactionModels list with at least one valid entry replaces the prior layer", () => {
		const result = shared.loadExtensionConfigFromLayers([
			{
				name: "DEFAULT_CONFIG",
				value: {
					compactionModels: [{ provider: "default", id: "model" }],
					thinkingLevel: "medium",
					debugCompactions: false,
				},
				required: true,
			},
			{
				name: "config.local.json",
				value: {
					compactionModels: [
						{ provider: 123, id: "bad" },
						{ provider: "local", id: "model", thinkingLevel: "invalid" },
					],
				},
			},
		]);

		expect(result.config.compactionModels).toEqual([{ provider: "local", id: "model" }]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"invalid-compaction-model",
			"invalid-thinking-level",
		]);
	});
});

describe("diligent-compact/shared model registry compatibility", () => {
	test("getCurrentModelWithApiKey falls back to getApiKeyForProvider", async () => {
		const fallbackModel = model("openai-codex", "gpt-5.4");
		const result = await shared.getCurrentModelWithApiKey({
			model: fallbackModel,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => provider === "openai-codex" ? "provider-key" : undefined,
			},
		} as any);

		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("provider-key");
		expect(result?.auth.apiKey).toBe("provider-key");
	});

	test("getCurrentModelWithApiKey falls back to authStorage.getApiKey", async () => {
		const fallbackModel = model("openai-codex", "gpt-5.4");
		const result = await shared.getCurrentModelWithApiKey({
			model: fallbackModel,
			modelRegistry: {
				authStorage: {
					getApiKey: async (provider: string) => provider === "openai-codex" ? "auth-key" : undefined,
				},
			},
		} as any);

		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("auth-key");
	});

	test("selectOpinionatedModel prefers find(provider, id) and accepts request-header-only auth", async () => {
		const configured = model("provider-a", "model-a");
		const findCalls: string[] = [];
		const result = await shared.selectOpinionatedModel(
			{
				model: model("current", "runtime"),
				modelRegistry: {
					find: async (provider: string, id: string) => {
						findCalls.push(`${provider}/${id}`);
						return provider === configured.provider && id === configured.id ? configured : undefined;
					},
					getAll: () => {
						throw new Error("getAll should not be used when find is available");
					},
					getApiKeyAndHeaders: async () => ({ ok: true, headers: { "x-provider-token": "header-token" } }),
				},
			} as any,
			"low",
			loadedConfig([{ provider: "provider-a", id: "model-a", thinkingLevel: "high" }]),
		);

		expect(findCalls).toEqual(["provider-a/model-a"]);
		expect(result.selected?.source).toBe("configured");
		expect(result.selected?.thinkingLevel).toBe("high");
		expect(result.selected?.auth).toEqual({ headers: { "x-provider-token": "header-token" } });
		expect(result.skippedConfiguredModels).toEqual([]);
	});

	test("selectOpinionatedModel preserves candidate order while recording unavailable, missing-auth, and auth-error skips", async () => {
		const noAuth = model("provider-a", "no-auth");
		const authError = model("provider-a", "auth-error");
		const usable = model("provider-a", "usable");
		const result = await shared.selectOpinionatedModel(
			{
				model: model("current", "runtime"),
				modelRegistry: {
					find: async (provider: string, id: string) => {
						if (provider !== "provider-a") return undefined;
						return { "no-auth": noAuth, "auth-error": authError, usable }[id];
					},
					getApiKeyAndHeaders: async (registryModel: any) => {
						if (registryModel.id === "no-auth") return { ok: true };
						if (registryModel.id === "auth-error") return { ok: false, message: "bad auth" };
						return { ok: true, apiKey: "usable-key" };
					},
				},
			} as any,
			"low",
			loadedConfig([
				{ provider: "missing", id: "model" },
				{ provider: "provider-a", id: "no-auth" },
				{ provider: "provider-a", id: "auth-error" },
				{ provider: "provider-a", id: "usable", thinkingLevel: "xhigh" },
			]),
		);

		expect(result.selected?.model).toBe(usable);
		expect(result.selected?.auth.apiKey).toBe("usable-key");
		expect(result.selected?.thinkingLevel).toBe("xhigh");
		expect(result.skippedConfiguredModels).toEqual([
			{ provider: "missing", id: "model", reason: "not-registered" },
			{ provider: "provider-a", id: "no-auth", reason: "missing-auth" },
			{ provider: "provider-a", id: "auth-error", reason: "auth-error", message: "bad auth" },
		]);
	});

	test("selectOpinionatedModel falls back to getAvailable plus provider-level api key lookup", async () => {
		const fallbackModel = model("openai-codex", "gpt-5.4");
		const result = await shared.selectOpinionatedModel(
			{
				model: model("anthropic", "runtime-current"),
				modelRegistry: {
					getAvailable: async () => [fallbackModel],
					getApiKeyForProvider: async (provider: string) => provider === "openai-codex" ? "provider-key" : undefined,
				},
			} as any,
			"low",
			loadedConfig([{ provider: "openai-codex", id: "gpt-5.4" }]),
		);

		expect(result.selected).not.toBeNull();
		expect(result.selected?.model.provider).toBe("openai-codex");
		expect(result.selected?.auth.apiKey).toBe("provider-key");
	});

	test("selectOpinionatedModel reports current-model fallback metadata", async () => {
		const currentModel = model("anthropic", "runtime-current");
		const result = await shared.selectOpinionatedModel(
			{
				model: currentModel,
				modelRegistry: {
					find: async () => undefined,
					getApiKeyAndHeaders: async (registryModel: any) => registryModel === currentModel
						? { ok: true, apiKey: "current-key" }
						: { ok: true },
				},
			} as any,
			"medium",
			loadedConfig([{ provider: "configured", id: "missing" }]),
		);

		expect(result.selected?.source).toBe("current-model");
		expect(result.selected?.model).toBe(currentModel);
		expect(result.selected?.auth.apiKey).toBe("current-key");
		expect(result.selected?.thinkingLevel).toBe("medium");
		expect(result.skippedConfiguredModels).toEqual([
			{ provider: "configured", id: "missing", reason: "not-registered" },
		]);
	});

	test("selectOpinionatedModel returns null instead of throwing for partial empty registries", async () => {
		const result = await shared.selectOpinionatedModel(
			{ model: model("openai-codex", "gpt-5.4"), modelRegistry: {} } as any,
			"low",
			loadedConfig([{ provider: "openai-codex", id: "gpt-5.4" }]),
		);
		expect(result.selected).toBeNull();
		expect(result.skippedConfiguredModels).toEqual([
			{ provider: "openai-codex", id: "gpt-5.4", reason: "not-registered" },
		]);
		await expect(shared.getCurrentModelWithApiKey({ model: model("openai-codex", "gpt-5.4"), modelRegistry: {} } as any)).resolves.toBeNull();
	});

	test("buildSelectionDiagnosticsWarning includes config diagnostics and skipped configured candidates", () => {
		const warning = shared.buildSelectionDiagnosticsWarning("diligent-compact", {
			selected: {
				model: model("anthropic", "runtime-current"),
				auth: { apiKey: "current-key" },
				thinkingLevel: "medium",
				source: "current-model",
			},
			skippedConfiguredModels: [
				{ provider: "provider-a", id: "missing", reason: "not-registered" },
				{ provider: "provider-a", id: "no-auth", reason: "missing-auth" },
			],
			configDiagnostics: [
				{ layer: "config.local.json", code: "invalid-thinking-level", message: "bad thinking" },
			],
		});

		expect(warning).toContain("diligent-compact: config warnings");
		expect(warning).toContain("using current session model anthropic/runtime-current");
		expect(warning).toContain("provider-a/missing: not-registered");
	});
});

describe("diligent-compact/shared request execution", () => {
	test("runOpinionatedCompactionRequest preserves request headers in completeSimple and records selection metadata", async () => {
		const configuredModel = model("anthropic", "claude-opus-4-7");
		const notifications: Array<{ text: string; level?: string }> = [];
		const result = await shared.runOpinionatedCompactionRequest({
			ctx: {
				model: model("current", "runtime"),
				modelRegistry: {
					find: async (provider: string, id: string) => provider === configuredModel.provider && id === configuredModel.id
						? configuredModel
						: undefined,
					getApiKeyAndHeaders: async () => ({
						ok: true,
						headers: { Authorization: "Bearer configured" },
					}),
				},
			} as any,
			preparation: makePreparation(),
			promptText: "Summarize this visible context.",
			systemPrompt: "System prompt",
			signal: new AbortController().signal,
			fallbackThinkingLevel: "low",
			loadedConfig: loadedConfig([{ provider: "anthropic", id: "claude-opus-4-7", thinkingLevel: "xhigh" }]),
			notify: (text, level) => notifications.push({ text, level }),
		});

		expect(completeSimpleCalls).toHaveLength(1);
		expect((completeSimpleCalls[0][2] as any).apiKey).toBeUndefined();
		expect((completeSimpleCalls[0][2] as any).headers).toEqual({ Authorization: "Bearer configured" });
		expect((completeSimpleCalls[0][2] as any).reasoning).toBe("xhigh");
		expect(result.details?.modelSource).toBe("configured");
		expect(result.details?.configuredModel).toEqual({
			provider: "anthropic",
			id: "claude-opus-4-7",
			thinkingLevel: "xhigh",
		});
		expect(notifications.some((notification) => notification.level === "warning")).toBe(false);
	});

	test("runOpinionatedCompactionRequest warns when configured candidates are skipped and current model fallback is used", async () => {
		const currentModel = model("local", "current");
		const notifications: Array<{ text: string; level?: string }> = [];
		const result = await shared.runOpinionatedCompactionRequest({
			ctx: {
				model: currentModel,
				modelRegistry: {
					find: async () => undefined,
					getApiKeyAndHeaders: async (registryModel: any) => registryModel === currentModel
						? { ok: true, apiKey: "current-key" }
						: { ok: true },
				},
			} as any,
			preparation: makePreparation(),
			promptText: "Summarize this visible context.",
			systemPrompt: "System prompt",
			signal: new AbortController().signal,
			fallbackThinkingLevel: "medium",
			loadedConfig: loadedConfig([{ provider: "configured", id: "missing" }]),
			notify: (text, level) => notifications.push({ text, level }),
		});

		expect(result.details?.modelSource).toBe("current-model");
		expect(result.details?.provider).toBe("local");
		expect(notifications.filter((notification) => notification.level === "warning")).toHaveLength(1);
		expect(notifications[0].text).toContain("using current session model local/current");
	});

	test("runCompatibilityCompactionRequest calls current native compact argument order with auth headers and thinking level", async () => {
		const currentModel = model("openai-codex", "gpt-5.5");
		const parentController = new AbortController();
		const preparation = makePreparation({ messagesToSummarize: [] });
		await shared.runCompatibilityCompactionRequest({
			ctx: {
				model: currentModel,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({
						ok: true,
						apiKey: "current-key",
						headers: { "x-current-header": "current-header" },
					}),
				},
			} as any,
			preparation,
			customInstructions: "focus here",
			signal: parentController.signal,
			thinkingLevel: "high",
			systemPrompt: "System prompt",
			promptEstimateText: "estimate",
		});

		expect(nativeCompactCalls).toHaveLength(1);
		const call = nativeCompactCalls[0];
		expect(call[0]).toBe(preparation);
		expect(call[1]).toBe(currentModel);
		expect(call[2]).toBe("current-key");
		expect(call[3]).toEqual({ "x-current-header": "current-header" });
		expect(call[4]).toBe("focus here");
		expect(call[5]).toBeInstanceOf(AbortSignal);
		expect(call[6]).toBe("high");
	});
});
