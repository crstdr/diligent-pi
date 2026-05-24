import { expect, mock, test } from "bun:test";

mock.module("@mariozechner/pi-coding-agent", () => ({
	estimateTokens(value: unknown) {
		return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
	},
}));

const core = await import("../extensions/diligent-context/core.ts");
const fixtures = await import("../tests/support/diligent-context-fixtures.ts");

type DiligentContextRuntimeSnapshot = import("../extensions/diligent-context/core.ts").DiligentContextRuntimeSnapshot;
type DiligentContextState = import("../extensions/diligent-context/core.ts").DiligentContextState;
type EventMessage = import("../extensions/diligent-context/core.ts").EventMessage;
type VisibleProjection = ReturnType<typeof core.computeVisibleSnapshot>;
type DiligentContextBenchScenario = import("../tests/support/diligent-context-fixtures.ts").DiligentContextBenchScenario;

const BENCHMARK_CONFIG = {
	warmupIterations: 20,
	measuredIterations: 100,
	batches: 5,
} as const;

const EXPECTED_SCENARIOS = [
	"enabled-large-tool-history",
	"off-no-boundary",
	"enabled-with-checkpoints",
	"enabled-large-tool-args",
	"lost-anchor-recovery-shape",
];

type ContextHookEquivalentResult = {
	snapshot: DiligentContextRuntimeSnapshot;
	returnedMessageCount: number;
	projectedCheckpointMessageCount: number;
	rawMessageCount: number;
	filteredMessageCount: number;
	projectionPassesByDesign: number;
	diagnosticToolIdCount: number;
	cacheCloneMessageCount: number;
	filteredToRawIndexCount: number;
	tokenEstimateChecksum: number;
};

type ScenarioBenchmarkResult = {
	name: string;
	primary: boolean;
	messages: number;
	toolCalls: number;
	toolResults: number;
	checkpoints: number;
	projectionPasses: number;
	medianMs: number;
	p95Ms: number;
	minMs: number;
	maxMs: number;
	samples: number;
	batchMedians: number[];
	batchP95s: number[];
	medianSpreadPercent: number;
	p95SpreadPercent: number;
	consoleLogCalls: number;
	checksum: number;
};

let benchmarkChecksum = 0;

test("diligent-context context-shaping benchmark", () => {
	const scenarios = fixtures.buildDiligentContextBenchScenarios();
	expect(scenarios.map((scenario) => scenario.name)).toEqual(EXPECTED_SCENARIOS);

	const results = scenarios.map(measureScenario);
	console.log(formatBenchmarkReport(results));

	for (const result of results) {
		expect(result.samples).toBe(BENCHMARK_CONFIG.measuredIterations * BENCHMARK_CONFIG.batches);
		expect(result.medianMs).toBeGreaterThanOrEqual(0);
		expect(result.p95Ms).toBeGreaterThanOrEqual(result.medianMs);
	}
	expect(benchmarkChecksum).toBeGreaterThan(0);
});

function runContextHookEquivalent(scenario: DiligentContextBenchScenario): ContextHookEquivalentResult {
	const rawMessages = scenario.rawMessages;
	let effectiveState = scenario.state;
	let projection = core.computeVisibleSnapshot({ rawMessages, state: effectiveState });
	let projectionPassesByDesign = 1;

	if (scenario.simulateLostAnchorRecovery && projection.resolvedAnchorIndex === null) {
		const recoveredState = buildRecoveredAfterEntryState(rawMessages);
		if (recoveredState) {
			effectiveState = recoveredState;
			projection = core.computeVisibleSnapshot({ rawMessages, state: effectiveState });
			projectionPassesByDesign += 1;
		}
	}

	let rawTokenEstimate = 0;
	let filteredTokenEstimate = 0;
	if (effectiveState.enabled && projection.resolvedAnchorIndex !== null) {
		rawTokenEstimate = core.estimatePayloadTokens(rawMessages);
		filteredTokenEstimate = core.estimatePayloadTokens(projection.filteredMessages);
	}

	const snapshot = core.buildRuntimeSnapshotFromProjection({ rawMessages, state: effectiveState, projection });

	const cachedRawPayload = core.cloneEventMessages(snapshot.rawMessages) ?? [];
	const cachedLivePayload = core.cloneEventMessages(snapshot.filteredMessages) ?? [];
	const cachedVisibleToRawIndices = [...snapshot.filteredToRawIndices];
	const diagnostics = core.collectPayloadDiagnostics(cachedLivePayload);

	let projectedCheckpointMessageCount = 0;
	let returnedMessageCount = 0;
	if (shouldProjectCheckpoints(effectiveState, projection)) {
		projectedCheckpointMessageCount = core.buildProjectedCheckpointMessages(effectiveState).length;
		returnedMessageCount = projectedCheckpointMessageCount + (snapshot.filteredMessages?.length ?? 0);
	} else if (projection.changed) {
		returnedMessageCount = snapshot.filteredMessages?.length ?? 0;
	}

	return {
		snapshot,
		returnedMessageCount,
		projectedCheckpointMessageCount,
		rawMessageCount: snapshot.rawMessages?.length ?? 0,
		filteredMessageCount: snapshot.filteredMessages?.length ?? 0,
		projectionPassesByDesign,
		diagnosticToolIdCount: diagnostics.payloadToolIds.size,
		cacheCloneMessageCount: cachedRawPayload.length + cachedLivePayload.length,
		filteredToRawIndexCount: cachedVisibleToRawIndices.length,
		tokenEstimateChecksum: rawTokenEstimate + filteredTokenEstimate,
	};
}

function shouldProjectCheckpoints(state: DiligentContextState, projection: VisibleProjection): boolean {
	return state.enabled
		&& state.anchorMode !== "pending-here"
		&& projection.resolvedAnchorIndex !== null
		&& core.hasActiveCheckpoints(state);
}

function buildRecoveredAfterEntryState(rawMessages: EventMessage[]): DiligentContextState | null {
	for (let index = rawMessages.length - 1; index >= 0; index--) {
		if (core.getPayloadNarrativeLabel(rawMessages[index]) === null) continue;
		return core.buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: core.computePayloadFingerprint(rawMessages[index], index),
		});
	}
	return null;
}

function measureScenario(scenario: DiligentContextBenchScenario): ScenarioBenchmarkResult {
	const initial = runContextHookEquivalent(scenario);
	assertSnapshotInvariants(scenario, initial.snapshot);
	consumeResult(initial);

	const durations: number[] = [];
	const batchMedians: number[] = [];
	const batchP95s: number[] = [];
	let consoleLogCalls = 0;
	let checksum = 0;

	for (let batch = 0; batch < BENCHMARK_CONFIG.batches; batch++) {
		const measured = withSuppressedConsole(() => {
			for (let i = 0; i < BENCHMARK_CONFIG.warmupIterations; i++) {
				checksum += consumeResult(runContextHookEquivalent(scenario));
			}

			const batchDurations: number[] = [];
			for (let i = 0; i < BENCHMARK_CONFIG.measuredIterations; i++) {
				const startedAt = performance.now();
				const result = runContextHookEquivalent(scenario);
				batchDurations.push(performance.now() - startedAt);
				checksum += consumeResult(result);
			}
			return batchDurations;
		});

		consoleLogCalls += measured.consoleLogCalls;
		durations.push(...measured.value);
		batchMedians.push(median(measured.value));
		batchP95s.push(p95(measured.value));
	}

	return {
		name: scenario.name,
		primary: scenario.primary,
		messages: scenario.counts.messages,
		toolCalls: scenario.counts.assistantToolCallMessages,
		toolResults: scenario.counts.toolResults,
		checkpoints: scenario.counts.checkpointCount,
		projectionPasses: initial.projectionPassesByDesign,
		medianMs: median(durations),
		p95Ms: p95(durations),
		minMs: Math.min(...durations),
		maxMs: Math.max(...durations),
		samples: durations.length,
		batchMedians,
		batchP95s,
		medianSpreadPercent: spreadPercent(batchMedians, median(durations)),
		p95SpreadPercent: spreadPercent(batchP95s, p95(durations)),
		consoleLogCalls,
		checksum,
	};
}

function assertSnapshotInvariants(scenario: DiligentContextBenchScenario, snapshot: DiligentContextRuntimeSnapshot): void {
	expect(snapshot.rawMessages).not.toBeNull();
	expect(snapshot.filteredMessages).not.toBeNull();
	expect(containsCheckpointDisplayText(snapshot.rawMessages)).toBe(false);
	expect(containsCheckpointDisplayText(snapshot.filteredMessages)).toBe(false);
	for (const rawIndex of snapshot.filteredToRawIndices) {
		expect(Number.isInteger(rawIndex)).toBe(true);
		expect(rawIndex).toBeGreaterThanOrEqual(0);
		expect(rawIndex).toBeLessThan(scenario.rawMessages.length);
	}
}

function containsCheckpointDisplayText(messages: EventMessage[] | null): boolean {
	if (!messages) return false;
	const serialized = JSON.stringify(messages);
	return serialized.includes("[Diligent contemplation checkpoint]")
		|| serialized.includes("[Diligent provenance checkpoint]");
}

function withSuppressedConsole<T>(fn: () => T): { value: T; consoleLogCalls: number } {
	const originalLog = console.log;
	let consoleLogCalls = 0;
	console.log = (..._args: unknown[]) => {
		consoleLogCalls += 1;
	};
	try {
		return { value: fn(), consoleLogCalls };
	} finally {
		console.log = originalLog;
	}
}

function consumeResult(result: ContextHookEquivalentResult): number {
	const checksum = result.returnedMessageCount
		+ result.projectedCheckpointMessageCount
		+ result.rawMessageCount
		+ result.filteredMessageCount
		+ result.projectionPassesByDesign
		+ result.diagnosticToolIdCount
		+ result.cacheCloneMessageCount
		+ result.filteredToRawIndexCount
		+ result.tokenEstimateChecksum;
	benchmarkChecksum += checksum;
	return checksum;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
	return sorted[index];
}

function spreadPercent(values: number[], baseline: number): number {
	if (values.length === 0 || baseline === 0) return 0;
	return ((Math.max(...values) - Math.min(...values)) / baseline) * 100;
}

function formatBenchmarkReport(results: ScenarioBenchmarkResult[]): string {
	const lines = [
		"",
		"## diligent-context context-shaping benchmark",
		"",
		`Config: ${BENCHMARK_CONFIG.warmupIterations} warmup + ${BENCHMARK_CONFIG.measuredIterations} measured iterations x ${BENCHMARK_CONFIG.batches} batches per scenario`,
		"",
		"| Scenario | Primary | Messages | Tool calls | Tool results | Checkpoints | Projection passes | Median ms | P95 ms | Min ms | Max ms | Samples |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...results.map((result) => `| ${result.name} | ${result.primary ? "yes" : "no"} | ${result.messages} | ${result.toolCalls} | ${result.toolResults} | ${result.checkpoints} | ${result.projectionPasses} | ${formatMs(result.medianMs)} | ${formatMs(result.p95Ms)} | ${formatMs(result.minMs)} | ${formatMs(result.maxMs)} | ${result.samples} |`),
		"",
		"### Batch variance",
		"",
		"| Scenario | Batch medians ms | Batch p95 ms | Median spread | P95 spread | Console logs suppressed |",
		"| --- | --- | --- | ---: | ---: | ---: |",
		...results.map((result) => `| ${result.name} | ${formatSeries(result.batchMedians)} | ${formatSeries(result.batchP95s)} | ${formatPercent(result.medianSpreadPercent)} | ${formatPercent(result.p95SpreadPercent)} | ${result.consoleLogCalls} |`),
		"",
	].join("\n");
	return lines;
}

function formatMs(value: number): string {
	return value.toFixed(3);
}

function formatPercent(value: number): string {
	return `${value.toFixed(1)}%`;
}

function formatSeries(values: number[]): string {
	return values.map(formatMs).join(", ");
}
