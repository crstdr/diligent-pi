import {
	OFF_STATE,
	buildAnchoredState,
	buildCheckpointArtifact,
	computePayloadFingerprint,
	type ContentBlock,
	type DiligentContextState,
	type EventMessage,
} from "../../extensions/diligent-context/core.ts";

export type DiligentContextBenchScenarioName =
	| "enabled-large-tool-history"
	| "off-no-boundary"
	| "enabled-with-checkpoints"
	| "enabled-large-tool-args"
	| "lost-anchor-recovery-shape";

export type DiligentContextBenchScenario = {
	name: DiligentContextBenchScenarioName;
	description: string;
	primary: boolean;
	rawMessages: EventMessage[];
	state: DiligentContextState;
	simulateLostAnchorRecovery: boolean;
	counts: {
		messages: number;
		assistantToolCallMessages: number;
		toolResults: number;
		checkpointCount: number;
	};
};

const FIXED_CHECKPOINT_DATE = "2026-05-24T00:00:00.000Z";

export function makeUserText(text: string): EventMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

export function makeAssistantText(text: string): EventMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

export function makeAssistantToolCall(args: {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	text?: string;
}): EventMessage {
	const content: ContentBlock[] = [];
	if (args.text) content.push({ type: "text", text: args.text });
	content.push({
		type: "toolCall",
		id: args.id,
		name: args.name,
		arguments: args.arguments,
	});
	return { role: "assistant", content };
}

export function makeToolResult(args: {
	toolCallId: string;
	content: string;
	isError?: boolean;
}): EventMessage {
	return {
		role: "toolResult",
		toolCallId: args.toolCallId,
		content: args.content,
		isError: args.isError ?? false,
	};
}

export function buildDiligentContextBenchScenarios(): DiligentContextBenchScenario[] {
	return [
		buildEnabledLargeToolHistoryScenario(),
		buildOffNoBoundaryScenario(),
		buildEnabledWithCheckpointsScenario(),
		buildEnabledLargeToolArgsScenario(),
		buildLostAnchorRecoveryShapeScenario(),
	];
}

function buildEnabledLargeToolHistoryScenario(): DiligentContextBenchScenario {
	const rawMessages: EventMessage[] = [
		makeUserText("Start the deterministic benchmark session."),
		makeAssistantText("I will inspect the repository and then continue from a stable anchor."),
	];
	appendToolHistory(rawMessages, {
		prefix: "primary",
		toolPairs: 300,
		argumentShape: "medium",
		resultShape: "medium",
	});
	const anchor = makeAssistantText("Diligent benchmark anchor after the large historical tool prefix.");
	const anchorIndex = rawMessages.push(anchor) - 1;
	appendNarrativeTail(rawMessages, "primary", 4);
	return scenario({
		name: "enabled-large-tool-history",
		description: "Enabled after-entry anchor after a large tool-heavy prefix; primary benchmark scenario.",
		primary: true,
		rawMessages,
		state: buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: computePayloadFingerprint(anchor, anchorIndex),
		}),
		simulateLostAnchorRecovery: false,
	});
}

function buildOffNoBoundaryScenario(): DiligentContextBenchScenario {
	const rawMessages: EventMessage[] = [];
	for (let i = 0; i < 1_000; i++) {
		rawMessages.push(i % 2 === 0
			? makeUserText(`Guard no-boundary user message ${i}: ${repeatToken("u", 10)}`)
			: makeAssistantText(`Guard no-boundary assistant message ${i}: ${repeatToken("a", 10)}`));
	}
	return scenario({
		name: "off-no-boundary",
		description: "Diligent context is off; measures disabled snapshot/cache overhead.",
		primary: false,
		rawMessages,
		state: {
			...OFF_STATE,
			checkpoints: { ...OFF_STATE.checkpoints },
		},
		simulateLostAnchorRecovery: false,
	});
}

function buildEnabledWithCheckpointsScenario(): DiligentContextBenchScenario {
	const rawMessages: EventMessage[] = [
		makeUserText("Checkpoint guard setup."),
		makeAssistantText("I have completed an earlier tranche of work."),
	];
	appendToolHistory(rawMessages, {
		prefix: "checkpoint",
		toolPairs: 40,
		argumentShape: "small",
		resultShape: "small",
	});
	const anchor = makeAssistantText("Checkpoint guard anchor after the represented work.");
	const anchorIndex = rawMessages.push(anchor) - 1;
	appendNarrativeTail(rawMessages, "checkpoint", 3);
	const provenance = buildCheckpointArtifact({
		kind: "provenance",
		id: "provenance-bench",
		createdAt: FIXED_CHECKPOINT_DATE,
		body: "Files touched in the hidden prefix:\n- extensions/diligent-context/core.ts",
		visibleMessageCount: rawMessages.length,
	});
	const contemplation = buildCheckpointArtifact({
		kind: "contemplation",
		id: "contemplation-bench",
		createdAt: FIXED_CHECKPOINT_DATE,
		provider: "bench",
		model: "deterministic",
		body: "The prior visible work established the benchmark fixture shape and checkpoint invariant.",
		visibleMessageCount: rawMessages.length,
	});
	return scenario({
		name: "enabled-with-checkpoints",
		description: "Enabled anchor with active provenance and contemplation checkpoints.",
		primary: false,
		rawMessages,
		state: buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: computePayloadFingerprint(anchor, anchorIndex),
			checkpoints: { provenance, contemplation },
		}),
		simulateLostAnchorRecovery: false,
	});
}

function buildEnabledLargeToolArgsScenario(): DiligentContextBenchScenario {
	const rawMessages: EventMessage[] = [
		makeUserText("Large argument guard setup."),
		makeAssistantText("I will run fewer tools, but each tool payload is intentionally large."),
	];
	appendToolHistory(rawMessages, {
		prefix: "large-args",
		toolPairs: 80,
		argumentShape: "large",
		resultShape: "large",
	});
	const anchor = makeAssistantText("Large argument guard anchor after bulky tool payloads.");
	const anchorIndex = rawMessages.push(anchor) - 1;
	appendNarrativeTail(rawMessages, "large-args", 3);
	return scenario({
		name: "enabled-large-tool-args",
		description: "Enabled anchor with fewer tool calls but larger deterministic argument/result payloads.",
		primary: false,
		rawMessages,
		state: buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: computePayloadFingerprint(anchor, anchorIndex),
		}),
		simulateLostAnchorRecovery: false,
	});
}

function buildLostAnchorRecoveryShapeScenario(): DiligentContextBenchScenario {
	const rawMessages: EventMessage[] = [
		makeUserText("Lost-anchor guard setup."),
		makeAssistantText("The persisted boundary fingerprint will intentionally point at an absent message."),
	];
	appendToolHistory(rawMessages, {
		prefix: "lost-anchor",
		toolPairs: 120,
		argumentShape: "medium",
		resultShape: "medium",
	});
	appendNarrativeTail(rawMessages, "lost-anchor", 4);
	const absentAnchor = makeAssistantText("This old anchor message is absent from the current live payload.");
	return scenario({
		name: "lost-anchor-recovery-shape",
		description: "Enabled state with a missing anchor fingerprint; benchmark simulates local recovery and recomputation.",
		primary: false,
		rawMessages,
		state: buildAnchoredState({
			anchorMode: "after-entry",
			anchorFingerprint: computePayloadFingerprint(absentAnchor, 999),
		}),
		simulateLostAnchorRecovery: true,
	});
}

function scenario(args: Omit<DiligentContextBenchScenario, "counts">): DiligentContextBenchScenario {
	return {
		...args,
		counts: countScenario(args.rawMessages, args.state),
	};
}

function appendToolHistory(
	rawMessages: EventMessage[],
	args: {
		prefix: string;
		toolPairs: number;
		argumentShape: "small" | "medium" | "large";
		resultShape: "small" | "medium" | "large";
	},
): void {
	for (let i = 0; i < args.toolPairs; i++) {
		const id = `${args.prefix}-call-${i}`;
		rawMessages.push(makeAssistantToolCall({
			id,
			name: i % 5 === 0 ? "read_file" : i % 5 === 1 ? "file_search" : i % 5 === 2 ? "apply_edits" : i % 5 === 3 ? "git" : "exec_command",
			arguments: deterministicToolArguments(args.prefix, i, args.argumentShape),
		}));
		rawMessages.push(makeToolResult({
			toolCallId: id,
			content: deterministicToolResult(args.prefix, i, args.resultShape),
			isError: false,
		}));
	}
}

function appendNarrativeTail(rawMessages: EventMessage[], prefix: string, pairs: number): void {
	for (let i = 0; i < pairs; i++) {
		rawMessages.push(makeUserText(`${prefix} recent user request ${i}: continue from the current visible state.`));
		rawMessages.push(makeAssistantText(`${prefix} recent assistant response ${i}: acknowledged current task state.`));
	}
}

function deterministicToolArguments(prefix: string, index: number, shape: "small" | "medium" | "large"): Record<string, unknown> {
	const chunkCount = shape === "large" ? 56 : shape === "medium" ? 10 : 3;
	const chunkSize = shape === "large" ? 96 : shape === "medium" ? 48 : 20;
	return {
		path: `src/${prefix}/fixture-${String(index).padStart(4, "0")}.ts`,
		query: `${prefix} deterministic query ${index}`,
		range: { start: index, end: index + 12 },
		metadata: {
			attempt: index % 7,
			stable: true,
			tags: [`${prefix}-tag-${index % 5}`, `${prefix}-batch-${Math.floor(index / 10)}`],
		},
		chunks: Array.from({ length: chunkCount }, (_, chunkIndex) => (
			`${prefix}:${index}:${chunkIndex}:` + repeatToken(String.fromCharCode(97 + (chunkIndex % 26)), chunkSize)
		)),
	};
}

function deterministicToolResult(prefix: string, index: number, shape: "small" | "medium" | "large"): string {
	const lineCount = shape === "large" ? 28 : shape === "medium" ? 8 : 2;
	const lineSize = shape === "large" ? 90 : shape === "medium" ? 44 : 16;
	return Array.from({ length: lineCount }, (_, lineIndex) => (
		`${prefix} result ${index}.${lineIndex}: ${repeatToken(String.fromCharCode(65 + (lineIndex % 26)), lineSize)}`
	)).join("\n");
}

function repeatToken(token: string, count: number): string {
	return Array.from({ length: count }, () => token).join("");
}

function countScenario(rawMessages: EventMessage[], state: DiligentContextState): DiligentContextBenchScenario["counts"] {
	return {
		messages: rawMessages.length,
		assistantToolCallMessages: rawMessages.filter(hasAssistantToolCall).length,
		toolResults: rawMessages.filter((message) => message.role === "toolResult").length,
		checkpointCount: Number(state.checkpoints.provenance !== null) + Number(state.checkpoints.contemplation !== null),
	};
}

function hasAssistantToolCall(message: EventMessage): boolean {
	return message.role === "assistant"
		&& Array.isArray(message.content)
		&& message.content.some((block) => typeof block === "object" && block !== null && block.type === "toolCall");
}
