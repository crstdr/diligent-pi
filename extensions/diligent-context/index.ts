/**
 * diligent-context
 *
 * Removes stale tool chatter from model context while preserving the human conversation.
 * The boundary is stationary until the user moves it.
 *
 * Architecture: payload-grounded.
 * The picker and the pruning logic both operate on the same live payload universe,
 * so the displayed reclaim estimate matches what can actually be removed.
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import {
  DILIGENT_CONTEXT_CUSTOM_TYPE as CLEAN_CONTEXT_CUSTOM_TYPE,
  DILIGENT_CONTEXT_STATUS_KEY as STATUS_KEY,
  OFF_STATE,
  applyPruningAtBoundary,
  buildContextMessageEntries,
  collectPayloadDiagnostics,
  computePayloadFingerprint,
  countToolCalls,
  estimatePayloadTokens,
  formatTokens,
  getPayloadExactLabel,
  getPayloadNarrativeLabel,
  getTextBlocks,
  getToolCallNames,
  hasThinkingBlock,
  isToolHeavyMessage,
  loadStateFromSession,
  messagesMatchForContextAlignment,
  resolveAnchorIndex,
  setDiligentContextRuntimeSnapshot,
  truncate,
  type DiligentContextState as CleanContextState,
  type EventMessage,
  type SessionEntry,
} from "./core.ts";

type DynamicPickerItem = {
	value: string;
	label: string;
	description?: string;
	reclaimedTokens: number;
};

type PayloadExactItem = {
	payloadIndex: number;
	label: string;
	reclaimedTokens: number;
};

type PayloadPickerItem =
	| {
			kind: "entry";
			value: string;
			label: string;
			payloadIndex: number;
			reclaimedTokens: number;
	  }
	| {
			kind: "burst";
			value: string;
			label: string;
			entries: PayloadExactItem[];
			reclaimedTokens: number;
			burstTokens: number;
	  };

function buildPayloadExactItems(
	items: Array<{ msg: EventMessage; payloadIndex: number }>,
	getReclaimedTokens: (payloadIndex: number) => number,
): PayloadExactItem[] {
	const out: PayloadExactItem[] = [];
	for (const item of items) {
		const label = getPayloadExactLabel(item.msg);
		if (!label) continue;
		out.push({
			payloadIndex: item.payloadIndex,
			label,
			reclaimedTokens: getReclaimedTokens(item.payloadIndex),
		});
	}
	return makeUniqueLabels(out.reverse());
}

function summarizePayloadBurst(items: Array<{ msg: EventMessage; payloadIndex: number }>, burstTokens: number): string {
	const toolNames: string[] = [];
	const seen = new Set<string>();
	let totalCalls = 0;
	for (const item of items) {
		const names = getToolCallNames(item.msg.content);
		totalCalls += names.length;
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			toolNames.push(name);
		}
	}
	const noun = totalCalls === 1 ? "call" : "calls";
	const tools = toolNames.length > 0 ? truncate(toolNames.join(", "), 40) : "tools";
	return `🔧 ${totalCalls} ${noun} · ${tools} · ${formatTokens(burstTokens)}`;
}

function makeUniqueLabels<T extends { label: string }>(items: T[]): T[] {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const count = seen.get(item.label) ?? 0;
		seen.set(item.label, count + 1);
		if (count === 0) return item;
		return { ...item, label: `${item.label} · ${count + 1}` } as T;
	});
}

function buildPayloadPickerItems(messages: EventMessage[]): PayloadPickerItem[] {
	const items: PayloadPickerItem[] = [];
	let burstItems: Array<{ msg: EventMessage; payloadIndex: number }> = [];
	let burstIndex = 0;
	const reclaimedTokenCache = new Map<number, number>();
	const getReclaimedTokens = (payloadIndex: number): number => {
		const cached = reclaimedTokenCache.get(payloadIndex);
		if (cached !== undefined) return cached;
		const result = applyPruningAtBoundary(messages, payloadIndex, "from-entry");
		reclaimedTokenCache.set(payloadIndex, result.reclaimedTokens);
		return result.reclaimedTokens;
	};

	const flushBurst = (): void => {
		if (burstItems.length === 0) return;
		const burstSnapshot = burstItems;
		burstItems = [];
		const exactItems = buildPayloadExactItems(burstSnapshot, getReclaimedTokens);
		if (exactItems.length === 0) return;
		if (exactItems.length === 1) {
			const [only] = exactItems;
			items.push({
				kind: "entry",
				value: `entry:${only.payloadIndex}`,
				label: only.label,
				payloadIndex: only.payloadIndex,
				reclaimedTokens: only.reclaimedTokens,
			});
			return;
		}

		const firstIndex = burstSnapshot[0]?.payloadIndex ?? 0;
		const lastIndex = burstSnapshot[burstSnapshot.length - 1]?.payloadIndex ?? firstIndex;
		const burstTokens = Math.max(0, getReclaimedTokens(lastIndex + 1) - getReclaimedTokens(firstIndex));
		items.push({
			kind: "burst",
			value: `burst:${burstIndex++}`,
			label: summarizePayloadBurst(burstSnapshot, burstTokens),
			entries: exactItems,
			reclaimedTokens: getReclaimedTokens(firstIndex),
			burstTokens,
		});
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			continue;
		}
		if (isToolHeavyMessage(msg)) {
			burstItems.push({ msg, payloadIndex: i });
			continue;
		}

		const label = getPayloadNarrativeLabel(msg);
		if (!label) {
			flushBurst();
			continue;
		}

		flushBurst();
		items.push({
			kind: "entry",
			value: `entry:${i}`,
			label,
			payloadIndex: i,
			reclaimedTokens: getReclaimedTokens(i),
		});
	}

	flushBurst();
	return makeUniqueLabels(items.reverse());
}

async function showDynamicPicker(
	ctx: ExtensionContext,
	baseTitle: string,
	items: DynamicPickerItem[],
	helpText: string,
	descriptionTone: "muted" | "error" = "muted",
	initialValue?: string,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const pageSize = Math.min(items.length, 12);
		const initialIndex = Math.max(
			0,
			initialValue ? items.findIndex((item) => item.value === initialValue) : 0,
		);
		let currentTokens = items[initialIndex]?.reclaimedTokens ?? 0;
		const titleWidget = new Text("", 1, 0);
		const updateTitle = (): void => {
			const title = theme.fg("accent", theme.bold(baseTitle));
			const tokenSuffix =
				currentTokens > 0 ? theme.fg("error", theme.bold(` [${formatTokens(currentTokens)} reclaimed]`)) : "";
			titleWidget.setText(`${title}${tokenSuffix}`);
		};
		updateTitle();
		container.addChild(titleWidget);

		const listItems: SelectItem[] = items.map((item) => ({
			value: item.value,
			label: item.label,
			description: item.description ?? "",
		}));

		const list = new SelectList(listItems, pageSize, {
			selectedPrefix: (t) => theme.fg("accent", theme.bold(t)),
			selectedText: (t) => theme.fg("accent", theme.bold(t)),
			description: (t) => theme.fg(descriptionTone, t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		const listAny = list as unknown as { selectedIndex?: number };
		listAny.selectedIndex = initialIndex;
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", helpText), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "\u001b[C" || data === "\u001b[D") {
					const current = listAny.selectedIndex ?? 0;
					const delta = data === "\u001b[C" ? pageSize : -pageSize;
					listAny.selectedIndex = Math.max(0, Math.min(items.length - 1, current + delta));
				} else {
					list.handleInput?.(data);
				}
				const idx = listAny.selectedIndex ?? 0;
				const item = items[idx];
				if (item) {
					currentTokens = item.reclaimedTokens;
					updateTitle();
				}
				tui.requestRender();
			},
		};
	});
}

function describeState(state: CleanContextState): string {
	if (!state.enabled) return "OFF";
	if (state.anchorMode === "pending-here") return "ON (pending anchor on next message)";
	return state.anchorMode === "after-entry" ? "ON (starting fresh from here)" : "ON (anchored from live context)";
}

function buildTitle(state: CleanContextState): string {
	return `Diligent Context — ${describeState(state)}`;
}

function updateStatus(ctx: ExtensionContext, state: CleanContextState, messages?: EventMessage[] | null): void {
	if (!ctx.hasUI) return;
	if (!state.enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	if (state.anchorMode === "pending-here") {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "anchor:pending"));
		return;
	}
	if (!messages || messages.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "anchor:restoring"));
		return;
	}
	const resolvedAnchorIndex = resolveAnchorIndex(messages, state.anchorFingerprint);
	const statusText =
		resolvedAnchorIndex === null
			? "anchor:?"
			: `anchor:${resolvedAnchorIndex + 1}/${messages.length}`;
	ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", statusText));
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	console.log(message);
}

export default function diligentContextExtension(pi: ExtensionAPI) {
	let state: CleanContextState = OFF_STATE;
	let cachedLivePayload: EventMessage[] | null = null;
	let cachedRawPayload: EventMessage[] | null = null;
	let cachedVisibleToRawIndices: number[] = [];
	let previousPayloadIds: Set<string> | null = null;

	const getSessionId = (ctx: ExtensionContext): string | null => ctx.sessionManager.getSessionId?.() ?? null;

	const reconstruct = (ctx: ExtensionContext): void => {
		state = loadStateFromSession(ctx);
		cachedLivePayload = null;
		cachedRawPayload = null;
		cachedVisibleToRawIndices = [];
		previousPayloadIds = null;
		setDiligentContextRuntimeSnapshot(getSessionId(ctx), null);
		updateStatus(ctx, state, cachedRawPayload);
	};

	const refreshCachedSnapshot = (ctx: ExtensionContext): void => {
		if (!cachedRawPayload) {
			cachedLivePayload = null;
			cachedVisibleToRawIndices = [];
			previousPayloadIds = null;
			setDiligentContextRuntimeSnapshot(getSessionId(ctx), null);
			return;
		}
		let filteredMessages = cachedRawPayload;
		let keptRawIndices = cachedRawPayload.map((_, index) => index);
		const resolvedAnchorIndex = state.enabled ? resolveAnchorIndex(cachedRawPayload, state.anchorFingerprint) : null;
		if (state.enabled && resolvedAnchorIndex !== null) {
			const pruneResult = applyPruningAtBoundary(cachedRawPayload, resolvedAnchorIndex, state.anchorMode ?? "from-entry");
			filteredMessages = pruneResult.filteredMessages;
			keptRawIndices = pruneResult.keptRawIndices;
		}
		cachedVisibleToRawIndices = keptRawIndices;
		cachedLivePayload = filteredMessages.map((msg) => ({ ...msg }));
		setDiligentContextRuntimeSnapshot(getSessionId(ctx), {
			state,
			rawMessages: cachedRawPayload,
			filteredMessages: cachedLivePayload,
			filteredToRawIndices: [...cachedVisibleToRawIndices],
			resolvedAnchorIndex,
		});
	};

	const reconcileTurnEndSnapshot = (ctx: ExtensionContext, message: EventMessage): void => {
		if (!cachedRawPayload) return;
		if (message.role !== "assistant") return;
		const branchEntries = (ctx.sessionManager.getBranch?.() ?? []) as SessionEntry[];
		const contextEntries = buildContextMessageEntries(branchEntries);
		let rawIndex = 0;
		const remainingEntries: Array<{ sourceType: string; message: EventMessage }> = [];
		for (const contextEntry of contextEntries) {
			if (rawIndex < cachedRawPayload.length) {
				if (messagesMatchForContextAlignment(contextEntry.message, cachedRawPayload[rawIndex])) {
					rawIndex += 1;
					continue;
				}
				if (contextEntry.sourceType === "custom_message") {
					continue;
				}
				console.log(`[diligent-context.turn_end] skip: prefix mismatch at ${rawIndex}`);
				return;
			}
			remainingEntries.push(contextEntry);
		}
		if (rawIndex !== cachedRawPayload.length) {
			console.log(`[diligent-context.turn_end] skip: matched=${rawIndex} cached=${cachedRawPayload.length}`);
			return;
		}
		const remainingRequired = remainingEntries.filter((entry) => entry.sourceType !== "custom_message");
		if (remainingRequired.length !== 1) {
			console.log(
				`[diligent-context.turn_end] skip: remainingRequired=${remainingRequired.length} remainingTotal=${remainingEntries.length}`,
			);
			return;
		}
		const [finalRequired] = remainingRequired;
		if (finalRequired.message.role !== "assistant" || !messagesMatchForContextAlignment(finalRequired.message, message)) {
			console.log("[diligent-context.turn_end] skip: final assistant mismatch");
			return;
		}
		const clonedMessage: EventMessage = {
			...message,
			content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
		};
		cachedRawPayload = [...cachedRawPayload, clonedMessage];
		refreshCachedSnapshot(ctx);
		if (cachedLivePayload) {
			previousPayloadIds = collectPayloadDiagnostics(cachedLivePayload).payloadToolIds;
		}
		updateStatus(ctx, state, cachedRawPayload);
	};

	const persist = (ctx: ExtensionContext): void => {
		pi.appendEntry(CLEAN_CONTEXT_CUSTOM_TYPE, state);
		refreshCachedSnapshot(ctx);
		updateStatus(ctx, state, cachedRawPayload);
	};

	const setAnchorHere = (ctx: ExtensionContext): boolean => {
		const lastVisibleIndex = cachedLivePayload && cachedLivePayload.length > 0 ? cachedLivePayload.length - 1 : -1;
		const lastRawIndex = lastVisibleIndex >= 0 ? cachedVisibleToRawIndices[lastVisibleIndex] : undefined;
		const lastRawMessage =
			typeof lastRawIndex === "number" && cachedRawPayload && cachedRawPayload[lastRawIndex]
				? cachedRawPayload[lastRawIndex]
				: null;
		if (!lastRawMessage || !cachedLivePayload) {
			state = {
				enabled: true,
				anchorMode: "pending-here",
				anchorFingerprint: null,
			};
			persist(ctx);
			return true;
		}
		state = {
			enabled: true,
			anchorMode: "after-entry",
			anchorFingerprint: computePayloadFingerprint(lastRawMessage, lastRawIndex),
		};
		persist(ctx);
		return true;
	};

	const setAnchorFromPayloadIndex = (ctx: ExtensionContext, payloadIndex: number): void => {
		const rawIndex = cachedVisibleToRawIndices[payloadIndex];
		if (!cachedLivePayload || !cachedLivePayload[payloadIndex] || typeof rawIndex !== "number" || !cachedRawPayload || !cachedRawPayload[rawIndex]) {
			notify(ctx, "diligent-context: selected live context entry is no longer available", "warning");
			return;
		}
		state = {
			enabled: true,
			anchorMode: "from-entry",
			anchorFingerprint: computePayloadFingerprint(cachedRawPayload[rawIndex], rawIndex),
		};
		persist(ctx);
	};

	const turnOff = (ctx: ExtensionContext): void => {
		state = OFF_STATE;
		cachedLivePayload = null;
		cachedRawPayload = null;
		cachedVisibleToRawIndices = [];
		previousPayloadIds = null;
		setDiligentContextRuntimeSnapshot(getSessionId(ctx), null);
		persist(ctx);
	};

	const pickBoundaryFromHistory = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!ctx.hasUI) {
			notify(ctx, "diligent-context: pick requires an interactive UI", "warning");
			return false;
		}

		if (!cachedLivePayload || cachedLivePayload.length === 0) {
			notify(ctx, "diligent-context: no live context available yet — send a message first, then pick", "warning");
			return false;
		}

		const topLevelItems = buildPayloadPickerItems(cachedLivePayload);
		if (topLevelItems.length === 0) {
			notify(ctx, "diligent-context: no live payload entries available to anchor", "warning");
			return false;
		}

		while (true) {
			const currentRawAnchorIndex = state.enabled && cachedRawPayload
				? resolveAnchorIndex(cachedRawPayload, state.anchorFingerprint)
				: null;
			const currentAnchorIndex =
				currentRawAnchorIndex === null
					? null
					: (() => {
						const idx = cachedVisibleToRawIndices.indexOf(currentRawAnchorIndex);
						return idx >= 0 ? idx : null;
					})();
			const currentTopLevelItem =
				currentAnchorIndex === null
					? null
					: topLevelItems.find((item) =>
							item.kind === "entry"
								? item.payloadIndex === currentAnchorIndex
								: item.entries.some((entry) => entry.payloadIndex === currentAnchorIndex),
						);
			let lastShownReclaimedTokens: number | null = null;
			const topChoice = await showDynamicPicker(
				ctx,
				"Pick retention boundary",
				topLevelItems.map((item) => {
					const isCurrent = currentTopLevelItem?.value === item.value;
					const shouldShowDescription = item.reclaimedTokens > 0 && item.reclaimedTokens !== lastShownReclaimedTokens;
					if (shouldShowDescription) {
						lastShownReclaimedTokens = item.reclaimedTokens;
					}
					return {
						value: item.value,
						label: isCurrent ? `${item.label} ${ctx.ui.theme.fg("error", "[current]")}` : item.label,
						description: shouldShowDescription ? `${formatTokens(item.reclaimedTokens)} reclaimed` : undefined,
						reclaimedTokens: item.reclaimedTokens,
					};
				}),
				"↑/↓ navigate   ←/→ page   Enter select   Esc cancel",
				"error",
				currentTopLevelItem?.value,
			);
			if (!topChoice) return false;

			const picked = topLevelItems.find((item) => item.value === topChoice);
			if (!picked) return false;

			if (picked.kind === "entry") {
				setAnchorFromPayloadIndex(ctx, picked.payloadIndex);
				const tokenInfo = picked.reclaimedTokens > 0 ? ` (${formatTokens(picked.reclaimedTokens)} reclaimed)` : "";
				notify(ctx, `diligent-context: anchored from live context${tokenInfo}`, "info");
				return true;
			}

			const exactChoice = await showDynamicPicker(
				ctx,
				picked.label,
				picked.entries.map((entry) => {
					const isCurrent = currentAnchorIndex === entry.payloadIndex;
					return {
						value: `entry:${entry.payloadIndex}`,
						label: isCurrent ? `${entry.label} ${ctx.ui.theme.fg("error", "[current]")}` : entry.label,
						description: entry.reclaimedTokens > 0 ? `${formatTokens(entry.reclaimedTokens)} reclaimed` : undefined,
						reclaimedTokens: entry.reclaimedTokens,
					};
				}),
				"↑/↓ navigate   ←/→ page   Enter select   Esc back",
				"error",
				currentAnchorIndex !== null ? `entry:${currentAnchorIndex}` : undefined,
			);
			if (!exactChoice) continue;

			const exactEntry = picked.entries.find((entry) => `entry:${entry.payloadIndex}` === exactChoice);
			if (!exactEntry) return false;
			setAnchorFromPayloadIndex(ctx, exactEntry.payloadIndex);
			const tokenInfo = exactEntry.reclaimedTokens > 0 ? ` (${formatTokens(exactEntry.reclaimedTokens)} reclaimed)` : "";
			notify(ctx, `diligent-context: anchored from live context${tokenInfo}`, "info");
			return true;
		}
	};

	const showMenu = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			notify(ctx, `diligent-context: ${describeState(state)}. Usage: /diligent-context [here|off|pick]`, "info");
			return;
		}

		const menuItems: DynamicPickerItem[] = [
			{ value: "here", label: "Set boundary here", description: "(/diligent-context here)", reclaimedTokens: 0 },
			{ value: "pick", label: "Pick boundary from live context", description: "(/diligent-context pick)", reclaimedTokens: 0 },
		];
		if (state.enabled) {
			menuItems.push({ value: "off", label: "Turn off", description: "(/diligent-context off)", reclaimedTokens: 0 });
		}
		menuItems.push({ value: "cancel", label: "Cancel", description: "", reclaimedTokens: 0 });

		const choice = await showDynamicPicker(
			ctx,
			buildTitle(state),
			menuItems,
			"↑/↓ navigate   Enter select   Esc cancel",
			"muted",
		);
		if (!choice || choice === "cancel") return;
		if (choice === "here") {
			if (setAnchorHere(ctx)) {
				notify(
					ctx,
					state.anchorMode === "pending-here"
						? "diligent-context: anchor pending — will activate on next model call"
						: "diligent-context: anchored here",
					"info",
				);
			}
			return;
		}
		if (choice === "pick") {
			await pickBoundaryFromHistory(ctx);
			return;
		}
		if (choice === "off") {
			turnOff(ctx);
			notify(ctx, "diligent-context: OFF", "info");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		reconstruct(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		reconstruct(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		cachedLivePayload = null;
		cachedRawPayload = null;
		cachedVisibleToRawIndices = [];
		previousPayloadIds = null;
		setDiligentContextRuntimeSnapshot(getSessionId(ctx), null);
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		reconcileTurnEndSnapshot(ctx, event.message as EventMessage);
	});

	pi.registerCommand("diligent-context", {
		description:
			"Open Diligent Context settings (payload-grounded pruning for old tool calls/results). Usage: /diligent-context [here|off|pick]",
		handler: async (args, ctx) => {
			const trimmed = String(args ?? "").trim();
			if (!trimmed) {
				await showMenu(ctx);
				return;
			}
			if (trimmed === "here") {
				if (setAnchorHere(ctx)) {
					notify(
						ctx,
						state.anchorMode === "pending-here"
							? "diligent-context: anchor pending — will activate on next model call"
							: "diligent-context: anchored here",
						"info",
					);
				}
				return;
			}
			if (trimmed === "off") {
				turnOff(ctx);
				notify(ctx, "diligent-context: OFF", "info");
				return;
			}
			if (trimmed === "pick") {
				await pickBoundaryFromHistory(ctx);
				return;
			}
			notify(ctx, "Usage: /diligent-context [here|off|pick]", "warning");
		},
	});

	pi.on("context", async (event, ctx) => {
		const rawMessages = event.messages as EventMessage[];
		if (state.enabled && state.anchorMode === "pending-here") {
			let materializeIndex = -1;
			for (let i = rawMessages.length - 1; i >= 0; i--) {
				if (getPayloadNarrativeLabel(rawMessages[i]) !== null) {
					materializeIndex = i;
					break;
				}
			}
			const materializeMessage = materializeIndex >= 0 ? rawMessages[materializeIndex] : null;
			if (materializeMessage) {
				state = {
					enabled: true,
					anchorMode: "after-entry",
					anchorFingerprint: computePayloadFingerprint(materializeMessage, materializeIndex),
				};
				persist(ctx);
				console.log(`[diligent-context] pending-here resolved to after-entry at index ${materializeIndex}`);
			} else {
				console.log("[diligent-context] pending-here: no stable live payload narrative entry yet, staying pending");
			}
		}
		let filteredMessages = rawMessages;
		let keptRawIndices = rawMessages.map((_, index) => index);
		let changed = false;
		let actualReclaimedTokens = 0;
		const resolvedAnchorIndex = state.enabled ? resolveAnchorIndex(rawMessages, state.anchorFingerprint) : null;

		if (state.enabled) {
			if (resolvedAnchorIndex === null) {
				if (state.anchorMode !== "pending-here") {
					console.log("[diligent-context] anchor not found in live payload — skipping pruning (likely compacted away)");
				}
			} else {
				const pruneResult = applyPruningAtBoundary(rawMessages, resolvedAnchorIndex, state.anchorMode ?? "from-entry");
				filteredMessages = pruneResult.filteredMessages;
				keptRawIndices = pruneResult.keptRawIndices;
				changed = pruneResult.changed;
				actualReclaimedTokens = pruneResult.reclaimedTokens;
				console.log(
					`[diligent-context.debug] mode=${state.anchorMode ?? "null"} resolvedAnchor=${resolvedAnchorIndex} payloadPruneIds=${pruneResult.payloadPruneIds.size} protected=${pruneResult.protectedIds.size} before≈${estimatePayloadTokens(rawMessages)} after≈${estimatePayloadTokens(filteredMessages)} reclaimed≈${actualReclaimedTokens} changed=${changed}`,
				);
			}
		}

		cachedRawPayload = rawMessages.map((msg) => ({ ...msg }));
		cachedVisibleToRawIndices = keptRawIndices;
		cachedLivePayload = filteredMessages.map((msg) => ({ ...msg }));
		setDiligentContextRuntimeSnapshot(getSessionId(ctx), {
			state,
			rawMessages: cachedRawPayload,
			filteredMessages: cachedLivePayload,
			filteredToRawIndices: [...cachedVisibleToRawIndices],
			resolvedAnchorIndex,
		});
		updateStatus(ctx, state, cachedRawPayload);
		const currentDiagnostics = collectPayloadDiagnostics(cachedLivePayload);
		if (previousPayloadIds) {
			let stable = 0;
			for (const id of previousPayloadIds) {
				if (currentDiagnostics.payloadToolIds.has(id)) stable += 1;
			}
			console.log(
				`[diligent-context.stability] prev=${previousPayloadIds.size} curr=${currentDiagnostics.payloadToolIds.size} stable=${stable}`,
			);
		}
		previousPayloadIds = currentDiagnostics.payloadToolIds;

		return changed ? { messages: filteredMessages } : undefined;
	});
}
