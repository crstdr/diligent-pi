import { describe, expect, mock, test } from "bun:test";

mock.module("@mariozechner/pi-ai", () => ({
	completeSimple: async () => {
		throw new Error("not used in these tests");
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
	compact: async () => {
		throw new Error("not used in these tests");
	},
	convertToLlm: (value: unknown) => value,
	getMarkdownTheme: () => ({}),
	serializeConversation: () => "",
	estimateTokens(value: unknown) {
		return Math.ceil(JSON.stringify(value).length / 4);
	},
}));

const shared = await import("../extensions/diligent-compact/shared.ts");

const fallbackModel = { provider: "openai-codex", id: "gpt-5.4" } as any;
const altModel = { provider: "anthropic", id: "claude-opus-4-6" } as any;

describe("diligent-compact/shared model registry compatibility", () => {
	test("getCurrentModelWithApiKey falls back to getApiKeyForProvider", async () => {
		const result = await shared.getCurrentModelWithApiKey({
			model: fallbackModel,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => provider === "openai-codex" ? "provider-key" : undefined,
			},
		} as any);

		expect(result).not.toBeNull();
		expect(result?.apiKey).toBe("provider-key");
	});

	test("getCurrentModelWithApiKey falls back to authStorage.getApiKey", async () => {
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

	test("selectOpinionatedModel falls back to getAvailable plus provider-level api key lookup", async () => {
		const result = await shared.selectOpinionatedModel(
			{
				model: altModel,
				modelRegistry: {
					getAvailable: async () => [fallbackModel],
					getApiKeyForProvider: async (provider: string) => provider === "openai-codex" ? "provider-key" : undefined,
				},
			} as any,
			"low",
		);

		expect(result).not.toBeNull();
		expect(result?.model.provider).toBe("openai-codex");
		expect(result?.apiKey).toBe("provider-key");
	});

	test("selectOpinionatedModel falls back to current model when configured models are unavailable", async () => {
		const currentModel = { provider: "anthropic", id: "runtime-current" } as any;
		const result = await shared.selectOpinionatedModel(
			{
				model: currentModel,
				modelRegistry: {
					getAvailable: async () => [],
					getApiKeyForProvider: async (provider: string) => provider === "anthropic" ? "current-key" : undefined,
				},
			} as any,
			"medium",
		);

		expect(result).not.toBeNull();
		expect(result?.model.provider).toBe("anthropic");
		expect(result?.model.id).toBe("runtime-current");
		expect(result?.apiKey).toBe("current-key");
		expect(result?.thinkingLevel).toBe("medium");
	});

	test("selectOpinionatedModel returns null instead of throwing for partial empty registries", async () => {
		await expect(shared.selectOpinionatedModel({ model: fallbackModel, modelRegistry: {} } as any, "low")).resolves.toBeNull();
		await expect(shared.getCurrentModelWithApiKey({ model: fallbackModel, modelRegistry: {} } as any)).resolves.toBeNull();
	});
});
