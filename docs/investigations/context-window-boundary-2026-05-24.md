# Investigation: Diligent context boundaries and model context windows

## Summary
`/diligent-context` currently provides a tool-chatter pruning boundary, not a guarantee that the remaining model-visible payload fits the active model. The recommended direction is advisory runtime model-fit evaluation with deduped warnings/status, using shared pure budget math, while preserving checkpoint projection invariants and leaving persisted diligent state unchanged.

## Symptoms
- A user can set `/diligent-context here` at a point that may still leave more visible content than the currently selected model can fit.
- A user may later switch to a model with a smaller context window, making a previously safe diligent boundary unsafe.
- Current behavior around token budgets, warning, prevention, and recovery needs investigation.

## Background / Prior Research

### Git archaeology: existing budget handling
- Existing budget enforcement is concentrated in `diligent-compact` / `diligent-contemplate`, not in `/diligent-context here`.
- `extensions/diligent-compact/shared.ts` has `getSafePromptInputBudget(model, maxTokens?)` and `assertPromptFitsBudget(...)`, using `model.contextWindow`, `maxTokens`, and a safety margin.
- `extensions/diligent-context/core.ts` has `estimatePayloadTokens(...)`, currently used for UI/reclaim estimates/diagnostics, but not as a hard model-fit guard when setting or revalidating a boundary.
- No prior repo work appears to handle the exact case where a diligent boundary remains too large for the current model, or becomes too large after model switching.

### Pi extension API facts
- The installed Pi SDK exposes current model metadata through `ctx.model`; the relevant model shape includes `contextWindow: number` and `maxTokens: number`.
- Extensions can use `ctx.model?.contextWindow` and `ctx.model?.maxTokens` opportunistically during existing events.
- There is no public `pi.on("model_change")` hook. Model switches appear as session entries internally, but not as hook events. Extensions would need to detect model changes by comparing `ctx.model.provider` / `ctx.model.id` on existing hooks such as `context`, `turn_start`, `turn_end`, or session events.
- Pi exports `estimateTokens(...)`, already used by this repo.

### Provider documentation facts
- Official OpenAI model docs show context windows vary materially by model, for example GPT-5.1 is documented with a 400,000-token context window and 128,000 max output tokens: https://platform.openai.com/docs/models/gpt-5.1
- OpenAI docs note model context sizes differ across families and should be checked per model: https://platform.openai.com/docs/models
- Anthropic documents Claude context windows and notes newer Claude models return validation errors if prompt plus output exceeds the context window rather than silently truncating: https://docs.anthropic.com/en/docs/build-with-claude/context-windows
- Anthropic model docs show common Claude models at 200k context, with 1M context available for some models/betas: https://docs.anthropic.com/en/docs/about-claude/models/overview

## Investigator Findings

### 2026-05-24 — Runtime boundary/model-budget investigation

#### Executive finding

The seed hypothesis is confirmed. `diligent-context` estimates raw/filtered payload tokens for diagnostics and reclaim estimates, but it does not compare the final model-visible payload against the current model's `contextWindow`, `maxTokens`, or any safe-budget margin. The most important implementation detail is that the payload requiring validation is **not just** `snapshot.filteredMessages`: active checkpoints are prepended only in the `context` hook return value, while runtime snapshots intentionally remain raw-grounded.

#### Boundary creation/materialization paths checked

- `/diligent-context here` is wired through the command handler at `extensions/diligent-context/index.ts:790-801` and the menu path at `extensions/diligent-context/index.ts:715-724`, both calling `setAnchorHere(...)`.
- `setAnchorHere(...)` persists a `pending-here` state when no cached live payload exists (`extensions/diligent-context/index.ts:490-507`) or builds an `after-entry` anchored state from the cached live/raw payload (`extensions/diligent-context/index.ts:508-516`). It refreshes snapshots/status through `persist(...)`, but performs no model-budget check.
- `/diligent-context pick` ultimately calls `setAnchorFromPayloadIndex(...)`, which validates that the selected cached live/raw message still exists, then builds/persists a `from-entry` anchored state (`extensions/diligent-context/index.ts:519-543`). It has availability checks and warnings, but no `ctx.model`/budget logic.
- `pickBoundaryFromHistory(...)` builds UI options from `buildPayloadPickerItems(...)` and shows only reclaimed-token descriptions (`extensions/diligent-context/index.ts:548-649`, especially `extensions/diligent-context/index.ts:589-596` and `extensions/diligent-context/index.ts:622-629`). Reclaimed tokens are useful UX, but they are not a fit verdict.
- `pending-here` materializes during the next `context` event via `materializePendingHereBoundary(...)`, which finds the last narrative payload message and persists an `after-entry` state (`extensions/diligent-context/index.ts:651-671`). This path also has no budget check, so a deferred boundary can become unsafe before it first materializes.
- Lost-anchor recovery calls `recoverLostAnchorBoundary(...)`, temporarily resets to `pending-here`, then attempts materialization against the current raw payload (`extensions/diligent-context/index.ts:673-687`). Recovery can therefore silently create a boundary that still exceeds the active model's safe input budget.
- Repo search found no `ctx.model`, `contextWindow`, `maxTokens`, `budget`, or `safeBudget` references in `extensions/diligent-context/`; the only `contextWindow` matches are in tests for other extensions.

#### Context hook payload and exact fit-check location

- The `context` hook starts at `extensions/diligent-context/index.ts:816`. It loads persisted state, handles pending materialization, computes the visible projection, recovers lost anchors, stores a runtime snapshot, updates status, and then optionally returns a shaped message payload (`extensions/diligent-context/index.ts:816-871`).
- Current diagnostics compare raw vs filtered estimates only: `before≈${estimatePayloadTokens(rawMessages)}` and `after≈${estimatePayloadTokens(projection.filteredMessages)}` (`extensions/diligent-context/index.ts:839-840`). These diagnostics do not include projected checkpoints and are not compared to any model limit.
- Runtime snapshots are built before checkpoint projection (`extensions/diligent-context/index.ts:845-848`) using `buildRuntimeSnapshotFromProjection(...)`, which clones only raw and filtered real messages plus raw-index mapping (`extensions/diligent-context/core.ts:1526-1539`). This preserves the invariant that checkpoints never pollute snapshots.
- Checkpoint projection happens only at the final return boundary: `shouldProjectCheckpoints` is computed at `extensions/diligent-context/index.ts:860-864`; the return payload prepends `buildProjectedCheckpointMessages(state)` to `snapshot.filteredMessages` at `extensions/diligent-context/index.ts:868-871`.
- Therefore the fit estimate should be computed in the `context` hook **after** the final model-visible message list is assembled, but **before** returning it. A safe implementation should compute something equivalent to:
  - `finalVisibleMessages = shouldProjectCheckpoints ? [...buildProjectedCheckpointMessages(state), ...(snapshot.filteredMessages ?? [])] : (snapshot.filteredMessages ?? rawMessages)`
  - `visibleInputTokens = estimatePayloadTokens(finalVisibleMessages) + normal-chat-overhead`
  - compare against `safeBudget(ctx.model, ctx.model?.maxTokens)`.
- Important edge: the current early return at `extensions/diligent-context/index.ts:865-867` returns `undefined` when pruning did not change the payload and there are no checkpoints. Budget evaluation must still run before that early return, because an unchanged payload can still be unsafe for the current model.
- Existing tests verify the projection/snapshot split: `buildRuntimeSnapshotFromRawMessages never includes projected checkpoint messages` (`tests/diligent-context-core.test.ts:258-283`), `buildRuntimeSnapshotFromProjection never includes projected checkpoint messages` (`tests/diligent-context-core.test.ts:309-331`), and the `context` hook does project checkpoints while snapshots remain raw-grounded (`tests/diligent-context-recovery.test.ts:275-315`).

#### Budget helper precedent and reusable shape

- `diligent-context` already has `estimatePayloadTokens(...)`, which uses Pi's `estimateTokens(...)` for message-shaped objects and a character heuristic for strings (`extensions/diligent-context/core.ts:296-305`). It is suitable for message-payload estimates, but currently only supports estimation, not fit decisions.
- `diligent-compact/shared.ts` has the current safe-budget precedent: `getSafePromptInputBudget(model, maxTokens?)` uses `model.contextWindow` with a 128k fallback, subtracts output reserve, and subtracts a 3% safety margin clamped to 1024-4096 tokens (`extensions/diligent-compact/shared.ts:429-434`). `assertPromptFitsBudget(...)` throws a clear error when estimated input exceeds that safe budget (`extensions/diligent-compact/shared.ts:436-453`).
- Compaction uses the helper before native/opinionated model calls (`extensions/diligent-compact/shared.ts:716-724`, `extensions/diligent-compact/shared.ts:733-743`, `extensions/diligent-compact/shared.ts:807-814`). Contemplation wraps the same helper and converts failure into a warning/no-write exit (`extensions/diligent-contemplate/index.ts:351-361`).
- Recommended helper location: put shared budget math in `extensions/diligent-context/core.ts` or a new `extensions/diligent-context/budget.ts`, not by importing `diligent-compact/shared.ts` into `diligent-context`. `diligent-compact` already imports `diligent-context/core.ts`, so importing the other way would invert the documented dependency direction.
- Suggested pure helper shape:
  - `type BudgetModelLike = { provider?: string; id?: string; contextWindow?: number; maxTokens?: number }`
  - `getSafeModelInputBudget(model: BudgetModelLike | null | undefined, outputReserveTokens?: number): number`
  - `evaluateVisiblePayloadBudget({ label, model, messages, outputReserveTokens = model?.maxTokens, extraOverheadTokens }): { estimatedInputTokens, safeBudget, contextWindow, outputReserveTokens, safetyMargin, severity }`
  - `formatBudgetWarning(...)` for one-line notify/status text.
- Keep `assertPromptFitsBudget(...)` semantics for compaction/contemplation, but `diligent-context` should generally warn/status rather than throw: pruning can still improve a session even if it does not fully fit the current model, and the context hook cannot interactively ask the user to choose a different boundary.

#### Model-switch handling

- There is no repo usage of `pi.on("model_change")`; the `diligent-context` hooks are `session_start`, `session_switch`, `session_fork`, `session_tree`, `session_before_switch`, `session_compact`, `turn_end`, and `context` (`extensions/diligent-context/index.ts:737-816`). I did not independently inspect Pi SDK internals in this pass; this aligns with the seed constraint that no public model-change hook exists.
- Revalidation should therefore be opportunistic:
  - on every `context` hook, because it has the current `ctx.model` immediately before a model call (`extensions/diligent-context/index.ts:816-871`);
  - after `/diligent-context here`/`pick` command paths, so user-visible success messages are not misleading (`extensions/diligent-context/index.ts:790-810`);
  - on `turn_end` after `reconcileTurnEndSnapshot(...)` refreshes cached payloads (`extensions/diligent-context/index.ts:773-777`), for passive status updates after new content arrives;
  - on session reconstruction events only as `restoring/unknown` status until a live payload is available (`extensions/diligent-context/index.ts:737-750`).
- Track the last checked model key and severity per session (`provider/id/contextWindow/maxTokens` plus `ok|tight|unsafe`) so switching to a smaller model produces a single warning on severity transition, not one toast per context hook.

#### Warning/status surface recommendation

- Existing `diligent-context` status is centralized in `updateStatus(...)` and currently shows `anchor:pending`, `anchor:restoring`, `anchor:?`, or `anchor:K/N` with checkpoint count (`extensions/diligent-context/index.ts:296-318`). This is the right passive surface.
- Existing `diligent-context` notifications are one-line `ctx.ui.notify(...)` calls via `notify(...)` (`extensions/diligent-context/index.ts:320-326`), and current warnings follow `diligent-context: ...` phrasing (`extensions/diligent-context/index.ts:526`, `extensions/diligent-context/index.ts:550-561`, `extensions/diligent-context/index.ts:812`). This is the right active surface.
- Recommended non-noisy design:
  - status suffix only when non-OK, e.g. `anchor:42/90 cp:1 fit:tight` or `anchor:42/90 cp:1 fit:over`; no suffix in the OK case;
  - one warning toast only when severity worsens (`ok -> tight`, `ok/tight -> unsafe`) or immediately after the user anchors into an unsafe state;
  - inline the warning into existing success toasts for command paths rather than sending an additional toast, e.g. `diligent-context: anchored here [still ~145k visible; safe budget ~120k for provider/model]`;
  - clear tracked severity on `/diligent-context off` and `session_before_switch` (`extensions/diligent-context/index.ts:753-759`, `extensions/diligent-context/index.ts:803-806`).
- Avoid a widget: widgets are only used by `diligent-compact` for post-compaction summaries (`extensions/diligent-compact/index.ts:346-369`), and a persistent budget widget would be noisy compared with the current status/toast conventions.

#### Eliminated hypotheses

- **Existing model-budget guard in `diligent-context`: eliminated.** No budget/model references exist in the extension, and the traced boundary/context paths never compare estimates to `ctx.model`.
- **Reclaimed-token estimates imply model fit: eliminated.** Picker/menu code surfaces reclaimed tokens (`extensions/diligent-context/index.ts:589-596`, `extensions/diligent-context/index.ts:622-629`), but fit depends on remaining visible payload plus checkpoints plus overhead against the current model.
- **Runtime snapshots can be used directly for final fit without modification: eliminated.** Snapshots intentionally exclude projected checkpoints (`extensions/diligent-context/core.ts:1526-1539`), while returned messages may include them (`extensions/diligent-context/index.ts:868-871`).
- **Compaction/contemplation budget checks protect normal `/diligent-context` calls: eliminated.** Their guards run only inside compaction/contemplation request paths (`extensions/diligent-compact/shared.ts:716-724`, `extensions/diligent-compact/shared.ts:807-814`, `extensions/diligent-contemplate/index.ts:351-361`). Normal model context shaping bypasses them.
- **A model-change event is the right implementation point: eliminated for now.** No public hook is available per seed, and no such hook is registered in this repo; use existing hooks instead.
- **Synthetic checkpoint projection should be persisted to make sizing easier: eliminated.** This would violate documented and tested invariants that checkpoints never enter `rawMessages`, `filteredMessages`, or `filteredToRawIndices`.

#### Recommended implementation locations

1. `extensions/diligent-context/core.ts`
   - Add pure budget helpers near `estimatePayloadTokens(...)` (`extensions/diligent-context/core.ts:296-305`) so `diligent-context`, `diligent-compact`, and `diligent-contemplate` can share the same safe-budget formula without reversing dependencies.
   - Optionally add `buildModelVisibleMessages(state, projectionOrSnapshot)` to centralize checkpoint projection without contaminating snapshots.
2. `extensions/diligent-context/index.ts`
   - Add per-session budget severity tracking next to existing module caches (`extensions/diligent-context/index.ts:328-335`).
   - Extend `updateStatus(...)` or pass it a budget evaluation so the current anchor status can include `fit:tight`/`fit:over` (`extensions/diligent-context/index.ts:296-318`).
   - Evaluate budget in `setAnchorHere(...)`, `setAnchorFromPayloadIndex(...)`, and `materializePendingHereBoundary(...)` after candidate state/projection construction (`extensions/diligent-context/index.ts:490-543`, `extensions/diligent-context/index.ts:651-671`).
   - Evaluate final model-visible payload in the `context` hook before the early return and before returning shaped messages (`extensions/diligent-context/index.ts:860-871`).
3. `extensions/diligent-compact/shared.ts`
   - Re-export or delegate its current budget helpers to the new core helper to keep compaction/contemplation behavior aligned (`extensions/diligent-compact/shared.ts:429-453`).
4. Docs after implementation
   - Update `extensions/diligent-context/README.md` filtering/status sections and the top-level README architecture invariant to document that `diligent-context` warns when the current visible payload is tight/unsafe but does not persist synthetic checkpoint messages.

#### Tests to add if implementation proceeds

- Add direct budget-helper tests, either in a new `tests/diligent-context-budget.test.ts` or by extending `tests/diligent-compact-shared.test.ts`, pinning:
  - context-window fallback to 128k;
  - safety margin clamp at 1024-4096;
  - subtraction of explicit output reserve or `model.maxTokens`;
  - warning/error text formatting with provider/model and estimated/safe token counts.
- Add context-hook tests using the existing harness pattern in `tests/diligent-context-recovery.test.ts:99-146`:
  - final visible payload estimate includes projected checkpoints from `buildProjectedCheckpointMessages(...)` (`extensions/diligent-context/core.ts:1483-1485`) while runtime snapshot remains checkpoint-free;
  - unchanged/no-checkpoint payloads are still budget-evaluated before the `undefined` early return (`extensions/diligent-context/index.ts:865-867`);
  - changing `ctx.model.contextWindow` between two `context` calls emits only one severity-transition warning and updates status.
- Add command-path tests:
  - `/diligent-context here` persists the boundary but warns/annotates success when the post-pruning visible payload is still over safe budget;
  - `pending-here` materialization warns if the materialized boundary is unsafe;
  - `/diligent-context off` clears budget status/severity tracking.
- Extend checkpoint/accounting tests:
  - `tests/diligent-compact-visibility.test.ts:349-384` already proves checkpoint tokens are included in `tokensBefore`; add a sibling test for the new context budget helper to ensure the same projected checkpoint text is included in fit estimates.
- Existing budget coverage is incomplete: `tests/diligent-contemplate.test.ts:530-540` covers a failure notification for a tiny context window, but there is no direct unit coverage of `getSafePromptInputBudget(...)`/`assertPromptFitsBudget(...)` in `tests/diligent-compact-shared.test.ts`.

#### Uncertainties / follow-up questions

- The `context` event exposes chat messages, but this repo does not show Pi's full normal-chat overhead (system prompt, tool schemas, provider wrappers). The budget helper should include a conservative configurable `extraOverheadTokens` value; exact calibration may require observing real Pi payload failures.
- The seed says `ctx.model.maxTokens` is available. Current `diligent-compact` passes an explicit reserve into `assertPromptFitsBudget(...)`; the new normal-context helper should treat `ctx.model.maxTokens` as the default output reserve when present, but this should be validated against Pi's current model registry semantics.

## Investigation Log

### Phase 1.5 — External and archaeology checks
**Hypothesis:** Existing Pi/model APIs and repo history may already provide the pieces needed for boundary-fit checks.
**Findings:** Pi exposes current model metadata as `ctx.model`, including `contextWindow` and `maxTokens`, but no public model-change hook was found. Repo archaeology shows model budget enforcement exists for compaction/contemplation, not for `diligent-context`.
**Evidence:** `extensions/diligent-compact/shared.ts` budget helpers; `extensions/diligent-context/core.ts` token estimation; official provider docs linked in Background.
**Conclusion:** Confirmed. Boundary fit must be evaluated opportunistically on existing hooks using current model metadata.

### Phase 2 — Workspace context analysis
**Hypothesis:** `diligent-context` estimates visible tokens but does not compare them to a safe model input budget.
**Findings:** Context Builder confirmed boundary creation/materialization and the `context` hook do not enforce or warn about model fit. It also identified checkpoint projection as a key accounting edge.
**Evidence:** `extensions/diligent-context/index.ts` command/context flow; `extensions/diligent-context/core.ts` projection and checkpoint helpers; `extensions/diligent-compact/shared.ts` safe-budget precedent.
**Conclusion:** Confirmed.

### Phase 3 — Pair investigation
**Hypothesis:** The correct implementation point is after final model-visible messages are assembled, before `context` returns or early-returns.
**Findings:** Pair investigator confirmed the final payload may be either unchanged raw payload, filtered payload, or projected checkpoints plus filtered payload. Fit evaluation must run even before the current unchanged-payload early return, because a smaller selected model can make an otherwise unchanged payload unsafe.
**Evidence:** See `## Investigator Findings`, especially the traced refs around `extensions/diligent-context/index.ts:816-871`.
**Conclusion:** Confirmed.

### Phase 4 — Oracle synthesis
**Hypothesis:** Warnings/status are better than blocking boundary creation, and shared helper placement matters.
**Findings:** Oracle agreed with warning-first UX and recommended a small pure `extensions/diligent-context/budget.ts` module rather than expanding `core.ts` or importing from `diligent-compact/shared.ts`.
**Conclusion:** Confirmed and incorporated below.

## Root Cause
`diligent-context` currently optimizes for removing stale tool-call baggage, not for proving that the remaining visible payload fits the active model. A diligent boundary can therefore be valid, resolvable, and useful while still leaving too much model-visible content for the selected model.

The specific gaps are:

1. **No boundary-fit evaluation.** Boundary creation, picker selection, pending materialization, lost-anchor recovery, and the `context` hook do not compare final visible messages against `ctx.model.contextWindow`, `ctx.model.maxTokens`, or a safe input budget.
2. **No model-switch revalidation.** Pi does not expose a public model-change hook, and current `diligent-context` code does not opportunistically detect that a boundary which fit a larger model may no longer fit a smaller model.
3. **No unsafe-fit UX.** Existing status and notification surfaces report anchor state and checkpoint count, but not whether the current visible payload appears safe, tight, or over budget for the active model.
4. **Checkpoint projection accounting gap.** Active checkpoints are prepended only to the returned model-visible payload, not to runtime snapshots. Any fit check based only on `snapshot.filteredMessages` or `projection.filteredMessages` can undercount.

## Recommendations
1. **Add shared pure budget math in a new `extensions/diligent-context/budget.ts`.** Avoid importing `diligent-compact/shared.ts` from `diligent-context`, because that would invert the dependency direction. Keep the helper estimator-agnostic: callers provide `estimatedInputTokens`, model metadata, output reserve, and optional overhead; the helper returns fit/severity data.
2. **Keep existing fail-closed callers as wrappers.** `diligent-compact` and `diligent-contemplate` should continue to fail closed before explicit model calls, delegating to the new helper without changing semantics.
3. **Evaluate the actual returned model-visible payload in `diligent-context`.** Include projected checkpoints when they will be returned, but never store synthetic checkpoint messages in `rawMessages`, `filteredMessages`, or `filteredToRawIndices`.
4. **Run fit evaluation before the `context` hook early return.** An unchanged payload can still be unsafe after switching to a smaller model, so the no-change path still needs advisory validation.
5. **Warn/status rather than block by default.** Boundary creation should remain useful even if it does not fully solve context pressure. Warn users when the payload is tight or unsafe, suggest next actions, and do not automatically move boundaries, delete narrative history, compact, or switch models.
6. **Use deduped severity transitions.** Warn on creation/materialization if unsafe, and later only when severity worsens or model/state changes. Dedupe by session, state signature, model provider/id/window/maxTokens, checkpoint state, and severity or over-budget band.
7. **Keep fit metadata runtime-only initially.** Fit status depends on current model, payload, projected checkpoints, estimator behavior, and reserve policy. Persisting it would create stale state and unnecessary schema churn.
8. **Treat output reserve as an explicit policy choice.** Initial implementation can use `ctx.model.maxTokens` when finite and positive, but normal chat reserve may need calibration because compaction prompt budgeting is not identical to live chat budgeting.
9. **Add picker fit annotations as a second phase.** After core warning/status behavior is reliable, `/diligent-context pick` can annotate candidates as fitting or still over budget for the current model.

## Preventive Measures
- Add direct unit tests for the new budget helper: context-window fallback, safety-margin clamp, output reserve subtraction, over-safe-budget vs over-hard-window severity, and formatting.
- Add context-hook tests that fit evaluation includes projected checkpoints while runtime snapshots remain checkpoint-free.
- Add tests proving fit evaluation runs before the unchanged-payload early return.
- Add model-switch simulation tests: a payload fits a large-context model, becomes unsafe for a smaller-context model, warns once, and updates status.
- Add command-path tests for `/diligent-context here`, deferred `pending-here` materialization, picker selection, and `/diligent-context off` clearing warning state.
- Update docs after implementation to clarify that `diligent-context` reduces stale tool-call baggage but cannot guarantee fit if the remaining human/assistant narrative is still too large; compaction or a later boundary may still be required.
