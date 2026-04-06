import { completeSimple, type UserMessage } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildAnchoredState,
	buildCheckpointArtifact,
	buildCheckpointDisplayText,
	buildProvenanceCheckpoint,
	buildRuntimeSnapshotFromRawMessages,
	computePayloadFingerprint,
	getActiveCheckpoints,
	getContextAlignmentComparable,
	getDiligentContextRuntimeSnapshot,
	getDiligentContextStateSignature,
	loadStateFromSession,
	setDiligentContextRuntimeSnapshot,
	DILIGENT_CHECKPOINT_CUSTOM_TYPE,
	DILIGENT_CONTEXT_CUSTOM_TYPE,
	type DiligentCheckpointArtifact,
	type DiligentContextRuntimeSnapshot,
	type EventMessage,
} from "../diligent-context/core.ts";
import {
	assertPromptFitsBudget,
	COMPACTION_TIMEOUT_MS,
	debugLog,
	selectOpinionatedModel,
	startTimedCompactionSignal,
} from "../diligent-compact/shared.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(EXTENSION_DIR, "contemplation-prompt.md");
const CONTEMPLATION_STATUS_KEY = "diligent-contemplate";
const CONTEMPLATION_SYSTEM_PROMPT =
	"You are a reflective session assistant. " +
	"Review the visible session context and produce a concise contemplation checkpoint. " +
	"Do NOT continue the conversation. " +
	"Do NOT answer unresolved user questions directly. " +
	"Output ONLY markdown for the checkpoint body.";
const DEFAULT_PROMPT_BODY = [
	"Contemplate on what we've worked on so far in this session.",
	"Make specific points about the tool calls we've used, because the user may prune tool-call history to clear working memory.",
	"Take conscious notes of the details that matter for future work in the next session.",
	"Keep it concise but specific.",
	"Use these sections:",
	"- What we accomplished",
	"- Tool calls that mattered",
	"- Details to carry forward",
	"- Open threads / risks",
].join("\n");
const CONTEMPLATION_MAX_TOKENS = 1200;
const inFlightBySession = new Set<string>();
const abortControllersBySession = new Map<string, AbortController>();

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

function notify(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	console.log(`[diligent-contemplate] ${level}: ${text}`);
}

function setStatus(ctx: ExtensionCommandContext, text?: string): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(CONTEMPLATION_STATUS_KEY, text ? theme.fg("accent", text) : undefined);
}

function getSessionId(ctx: ExtensionCommandContext): string | null {
	return ctx.sessionManager.getSessionId?.() ?? null;
}

function buildPromptText(args: {
	checkpointText?: string;
	conversationText: string;
	promptBody: string;
	customInstructions?: string;
}): string {
	const blocks = [`<visible_session>\n${args.conversationText.trim()}\n</visible_session>`, args.promptBody.trim()];
	const checkpointText = (args.checkpointText ?? "").trim();
	if (checkpointText.length > 0) {
		blocks.unshift(`<active_checkpoints>\n${checkpointText}\n</active_checkpoints>`);
	}
	const trimmedInstructions = (args.customInstructions ?? "").trim();
	if (trimmedInstructions.length > 0) {
		blocks.push(`<custom_prompt>\n${trimmedInstructions}\n</custom_prompt>`);
	}
	return blocks.join("\n\n");
}

function buildCheckpointPromptText(snapshot: DiligentContextRuntimeSnapshot): string | undefined {
	const checkpoints = getActiveCheckpoints(snapshot.state);
	if (checkpoints.length === 0) return undefined;
	return checkpoints.map((checkpoint) => buildCheckpointDisplayText(checkpoint)).join("\n\n");
}

function hasUsableVisibleSnapshot(snapshot: DiligentContextRuntimeSnapshot | null): snapshot is DiligentContextRuntimeSnapshot & {
	filteredMessages: EventMessage[];
	rawMessages: EventMessage[];
} {
	if (!snapshot?.filteredMessages || snapshot.filteredMessages.length === 0) return false;
	if (!snapshot.rawMessages || snapshot.rawMessages.length === 0) return false;
	if (snapshot.filteredToRawIndices.length !== snapshot.filteredMessages.length) return false;
	if (snapshot.state.enabled && snapshot.state.anchorMode !== "pending-here" && snapshot.resolvedAnchorIndex === null) return false;
	return true;
}

function reconcileSnapshotWithState(
	sessionId: string,
	snapshot: DiligentContextRuntimeSnapshot | null,
	ctx: ExtensionCommandContext,
): DiligentContextRuntimeSnapshot | null {
	if (!snapshot) return null;
	const persistedState = loadStateFromSession(ctx);
	if (getDiligentContextStateSignature(snapshot.state) === getDiligentContextStateSignature(persistedState)) {
		return snapshot;
	}
	if (!snapshot.rawMessages) return null;
	const rebuilt = buildRuntimeSnapshotFromRawMessages(snapshot.rawMessages, persistedState);
	setDiligentContextRuntimeSnapshot(sessionId, rebuilt);
	return rebuilt;
}

function buildSnapshotSignature(snapshot: DiligentContextRuntimeSnapshot): string {
	return JSON.stringify({
		state: getDiligentContextStateSignature(snapshot.state),
		resolvedAnchorIndex: snapshot.resolvedAnchorIndex,
		rawCount: snapshot.rawMessages?.length ?? 0,
		filteredCount: snapshot.filteredMessages?.length ?? 0,
		filteredToRawCount: snapshot.filteredToRawIndices.length,
		filteredMessages: (snapshot.filteredMessages ?? []).map((message) => getContextAlignmentComparable(message)),
	});
}

function hasMessagesBeyondAnchor(snapshot: DiligentContextRuntimeSnapshot): boolean {
	if (snapshot.resolvedAnchorIndex === null) return snapshot.filteredMessages?.length ? true : false;
	return snapshot.filteredToRawIndices.some((rawIndex) => rawIndex > snapshot.resolvedAnchorIndex);
}

function reconcileCheckpoint(
	previousCheckpoint: DiligentCheckpointArtifact | null,
	nextCheckpoint: DiligentCheckpointArtifact | null,
): DiligentCheckpointArtifact | null {
	if (!previousCheckpoint || !nextCheckpoint) return nextCheckpoint;
	return previousCheckpoint.body === nextCheckpoint.body ? previousCheckpoint : nextCheckpoint;
}

function emitCheckpointMessages(previous: DiligentContextRuntimeSnapshot, nextCheckpoint: DiligentCheckpointArtifact, nextProvenance: DiligentCheckpointArtifact | null, pi: ExtensionAPI): void {
	const previousContemplation = previous.state.checkpoints.contemplation;
	if (previousContemplation?.id !== nextCheckpoint.id) {
		pi.sendMessage({
			customType: DILIGENT_CHECKPOINT_CUSTOM_TYPE,
			content: buildCheckpointDisplayText(nextCheckpoint),
			display: true,
			details: {
				checkpointId: nextCheckpoint.id,
				kind: nextCheckpoint.kind,
				active: true,
			},
		});
	}
	const previousProvenance = previous.state.checkpoints.provenance;
	if (nextProvenance && previousProvenance?.id !== nextProvenance.id) {
		pi.sendMessage({
			customType: DILIGENT_CHECKPOINT_CUSTOM_TYPE,
			content: buildCheckpointDisplayText(nextProvenance),
			display: true,
			details: {
				checkpointId: nextProvenance.id,
				kind: nextProvenance.kind,
				active: true,
			},
		});
	}
}

export default function diligentContemplateExtension(pi: ExtensionAPI): void {
	const abortInFlight = (sessionId: string | null | undefined): void => {
		if (!sessionId) return;
		abortControllersBySession.get(sessionId)?.abort();
	};

	pi.on("session_before_switch", async (_event, ctx) => {
		abortInFlight(getSessionId(ctx));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		abortInFlight(getSessionId(ctx));
	});

	pi.registerCommand("diligent-contemplate", {
		description: "Generate a visibility-aware contemplation checkpoint and move diligent-context after it. Usage: /diligent-contemplate [custom prompt]",
		handler: async (args, ctx) => {
			const sessionId = getSessionId(ctx);
			if (!sessionId) {
				notify(ctx, "diligent-contemplate: no active session", "warning");
				return;
			}
			if (inFlightBySession.has(sessionId)) {
				notify(ctx, "diligent-contemplate: already running for this session", "warning");
				return;
			}

			const initialSnapshot = reconcileSnapshotWithState(sessionId, getDiligentContextRuntimeSnapshot(sessionId), ctx);
			if (!hasUsableVisibleSnapshot(initialSnapshot)) {
				notify(ctx, "diligent-contemplate blocked: no current diligent-visible live context is available yet", "warning");
				return;
			}
			if (initialSnapshot.state.enabled && initialSnapshot.state.anchorMode !== "pending-here" && initialSnapshot.resolvedAnchorIndex === null) {
				const anchorLost = (initialSnapshot.rawMessages?.length ?? 0) > 0;
				notify(
					ctx,
					anchorLost
						? "diligent-contemplate blocked: the current diligent-context anchor was lost from live payload — send another message or run /diligent-context here to re-anchor"
						: "diligent-contemplate blocked: the current diligent-context boundary is still restoring",
					"warning",
				);
				return;
			}
			if (initialSnapshot.state.checkpoints.contemplation && !hasMessagesBeyondAnchor(initialSnapshot)) {
				notify(ctx, "diligent-contemplate blocked: nothing new has happened since the active contemplation checkpoint", "warning");
				return;
			}

			const startingSignature = buildSnapshotSignature(initialSnapshot);
			const customInstructions = String(args ?? "").trim();
			const promptBody = loadPromptBody();
			const conversationText = serializeConversation(convertToLlm(initialSnapshot.filteredMessages));
			const checkpointText = buildCheckpointPromptText(initialSnapshot);
			const promptText = buildPromptText({
				checkpointText,
				conversationText,
				promptBody,
				customInstructions,
			});
			const fallbackThinkingLevel = pi.getThinkingLevel();
			const selected = await selectOpinionatedModel(ctx, fallbackThinkingLevel);
			if (!selected) {
				notify(ctx, "diligent-contemplate failed: no model/API key available for contemplation", "warning");
				return;
			}
			try {
				assertPromptFitsBudget({
					label: "diligent-contemplate",
					model: selected.model,
					systemPrompt: CONTEMPLATION_SYSTEM_PROMPT,
					promptText,
					maxTokens: CONTEMPLATION_MAX_TOKENS,
					extraOverheadTokens: 512,
				});
			} catch (error) {
				notify(ctx, `diligent-contemplate failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}

			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			};
			const completeOptions: {
				apiKey: string;
				reasoning?: typeof selected.thinkingLevel;
				maxTokens: number;
			} = {
				apiKey: selected.apiKey,
				maxTokens: CONTEMPLATION_MAX_TOKENS,
			};
			if (selected.thinkingLevel !== "off") {
				completeOptions.reasoning = selected.thinkingLevel;
			}

			const parentAbortController = new AbortController();
			abortControllersBySession.set(sessionId, parentAbortController);
			inFlightBySession.add(sessionId);
			setStatus(ctx, "diligent-contemplate: running");
			notify(
				ctx,
				`diligent-contemplate: reflecting on ${initialSnapshot.filteredMessages.length} visible messages with ${selected.model.provider}/${selected.model.id}`,
				"info",
			);

			const timed = startTimedCompactionSignal(parentAbortController.signal, COMPACTION_TIMEOUT_MS);
			try {
				const response = await completeSimple(
					selected.model,
					{ systemPrompt: CONTEMPLATION_SYSTEM_PROMPT, messages: [userMessage] },
					{ ...completeOptions, signal: timed.signal },
				);
				if (timed.didTimeout()) {
					throw new Error(`diligent-contemplate timed out after ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s`);
				}
				if (response.stopReason === "aborted") {
					throw new Error("diligent-contemplate cancelled");
				}
				if (response.stopReason === "error") {
					throw new Error(response.errorMessage ?? "diligent-contemplate failed");
				}

				const noteBody = response.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n")
					.trim();
				if (!noteBody) {
					throw new Error("diligent-contemplate returned empty output");
				}

				const liveSnapshot = reconcileSnapshotWithState(sessionId, getDiligentContextRuntimeSnapshot(sessionId), ctx);
				if (!liveSnapshot || buildSnapshotSignature(liveSnapshot) !== startingSignature) {
					throw new Error("diligent-contemplate aborted because the live visible context changed while the checkpoint was generating");
				}
				if (getSessionId(ctx) !== sessionId) {
					throw new Error("diligent-contemplate aborted because the active session changed");
				}

				const lastVisibleRawIndex = liveSnapshot.filteredToRawIndices[liveSnapshot.filteredToRawIndices.length - 1];
				if (typeof lastVisibleRawIndex !== "number" || !liveSnapshot.rawMessages[lastVisibleRawIndex]) {
					throw new Error("diligent-contemplate failed because the diligent-visible boundary could not be anchored safely");
				}

				const contemplationCheckpoint = buildCheckpointArtifact({
					kind: "contemplation",
					body: noteBody,
					provider: selected.model.provider,
					model: selected.model.id,
					visibleMessageCount: liveSnapshot.filteredMessages.length,
				});
				const nextProvenance = reconcileCheckpoint(
					liveSnapshot.state.checkpoints.provenance,
					buildProvenanceCheckpoint({
						rawMessages: liveSnapshot.rawMessages,
						resolvedAnchorIndex: lastVisibleRawIndex,
						anchorMode: "after-entry",
					}),
				);
				const nextState = buildAnchoredState({
					anchorMode: "after-entry",
					anchorFingerprint: computePayloadFingerprint(liveSnapshot.rawMessages[lastVisibleRawIndex], lastVisibleRawIndex),
					checkpoints: {
						provenance: nextProvenance,
						contemplation: contemplationCheckpoint,
					},
				});

				pi.appendEntry(DILIGENT_CONTEXT_CUSTOM_TYPE, nextState);
				const rebuiltSnapshot = buildRuntimeSnapshotFromRawMessages(liveSnapshot.rawMessages, nextState);
				setDiligentContextRuntimeSnapshot(sessionId, rebuiltSnapshot);
				emitCheckpointMessages(liveSnapshot, contemplationCheckpoint, nextProvenance, pi);

				debugLog(
					`diligent-contemplate success provider=${selected.model.provider} model=${selected.model.id} visible=${liveSnapshot.filteredMessages.length}`,
				);
				notify(ctx, "diligent-contemplate: contemplation checkpoint saved and diligent-context moved after it", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `diligent-contemplate failed: ${message}`, "warning");
				debugLog(`diligent-contemplate error: ${message}`);
			} finally {
				timed.cleanup();
				abortControllersBySession.delete(sessionId);
				inFlightBySession.delete(sessionId);
				setStatus(ctx, undefined);
			}
		},
	});
}
