# diligent-pi Polish: Plan

## Goal
Make `diligent-pi` easier for more users and contributors to install, update, validate, configure, and trust, while preserving the current extension-owned checkpoint architecture and avoiding a package-wrapper or installer pivot for now.

This is a targeted readiness pass: polish the repo surface, tests, docs, and model configuration around the existing architecture rather than refactoring the runtime or changing persisted diligent state.

## Background
- User DX decisions for this plan: keep distribution as lightweight as possible for now; keep validation local-only rather than CI-first; treat model configuration as layered fallback rather than a hard sample-only or single committed frontier default.
- Root README positions this repo as the canonical source of truth and says distribution is currently manual `cp -R` into `~/.pi/agent/extensions/` or `<project>/.pi/extensions/`, with no package wrapper yet (`README.md:5`, `README.md:15-31`). It documents the three extension dependency chain but does not enforce it in tooling (`README.md:33-42`).
- `diligent-context` owns the pruning boundary and checkpoint memory. Its public spec says persisted state is authoritative, runtime snapshots are caches, synthetic checkpoints project only in the `context` return path, compaction clears checkpoints, and `pending-here` never coexists with active checkpoints (`extensions/diligent-context/spec.md:1-66`). Core exported state/type seams include `DILIGENT_CONTEXT_CUSTOM_TYPE`, `DILIGENT_CHECKPOINT_CUSTOM_TYPE`, `AnchorMode`, `CheckpointKind`, `DiligentCheckpointArtifact`, and `DiligentContextState` (`extensions/diligent-context/core.ts:1-42`).
- Projection and snapshot safety are concentrated in `buildProjectedCheckpointMessages`, `computeVisibleSnapshot`, `buildRuntimeSnapshotFromRawMessages`, and `normalizeState`; synthetic checkpoint messages are separate from real raw/filtered snapshots (`extensions/diligent-context/core.ts:1483-1538`).
- `diligent-compact` already implements the important fail-closed posture: compatibility/opinionated routes build visibility-aware preparation, cancel on unsafe mapping, and force-native is the explicit escape hatch (`extensions/diligent-compact/README.md:20-76`, `extensions/diligent-compact/README.md:90-108`). The route selection and preparation logic live inside `session_before_compact` today (`extensions/diligent-compact/index.ts:900-1082`), which makes the route/preparation matrix harder to unit-test.
- Active checkpoints are not ordinary history for compaction; they are supplied as carry-forward summary input while the runtime snapshot stays grounded in real payload only (`extensions/diligent-compact/README.md:64-76`).
- `diligent-contemplate` creates a visibility-aware contemplation checkpoint, stores it inside `diligent-context` state, emits a visible custom checkpoint artifact, and moves `diligent-context` after the last real visible message represented by the checkpoint (`extensions/diligent-contemplate/README.md:1-18`). Its command handler guards no visible snapshot, restoring/lost anchors, duplicate/no-new-work checkpoints, prompt budget failures, live-context mutation during generation, session changes, and empty output before writing state (`extensions/diligent-contemplate/index.ts:206-385`).
- Shared model settings currently live in `extensions/diligent-compact/config.json` and are consumed by both `diligent-compact` and `diligent-contemplate` (`extensions/diligent-compact/README.md:79-89`, `extensions/diligent-contemplate/README.md:48-58`). Current config is `anthropic/claude-opus-4-6`, `openai-codex/gpt-5.4`, `thinkingLevel: "xhigh"`, `debugCompactions: false` (`extensions/diligent-compact/config.json:1-8`).
- Current official model docs checked on 2026-05-24: OpenAI lists `gpt-5.5` as the flagship starting point for complex reasoning/coding and `gpt-5.4` as a more affordable coding/professional model, both with `xhigh` reasoning (`https://developers.openai.com/api/docs/models`). Anthropic lists `claude-opus-4-7` as the current most capable generally available Claude model, `claude-sonnet-4-6` as the speed/intelligence balance option, and says Claude 4.6+ dateless IDs are pinned snapshots rather than evergreen aliases (`https://platform.claude.com/docs/en/about-claude/models/overview`, `https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions`).
- Repo readiness gaps from exploration: no `package.json`, no `tsconfig.json`, no lockfile, no `.github/`, no `scripts/`, no `CHANGELOG.md`, no `CONTRIBUTING.md`, and no public `docs/` directory before this plan. Existing tests use `bun:test` and mocks under `tests/`, but the README does not document a runnable local validation workflow.
- Recent prior-art commits show the area has already been hardened incrementally rather than rewritten: lost anchor recovery (`ed935b6`, 2026-04-06), compaction registry compatibility tests (`ec2d025`, 2026-03-28), provenance grounding (`f7264fe`, 2026-03-26), and visibility/timeout handling (`4fc55ea`, 2026-03-12).
- Pi update reconnaissance on 2026-05-24 checked local installed Pi `@earendil-works/pi-coding-agent` 0.75.4 and upstream `origin/main` commit `9600ded9` / `@earendil-works/pi-coding-agent` 0.75.5. Current extension APIs live under `packages/coding-agent/src/core/...`; current packages use the `@earendil-works/*` scope, while the loader still aliases legacy `@mariozechner/*` imports. Current `ModelRegistry` exposes `find(...)`, `getAll()`, `getAvailable()`, `hasConfiguredAuth(...)`, and `getApiKeyAndHeaders(model)`, and native `compact(...)` now takes `headers` before `customInstructions` plus a later `thinkingLevel` slot.
- Oracle and `context_builder` guidance converged on the same shape: targeted readiness, no persisted state schema change, copy-based distribution, local validation, warning-oriented layered config, current Pi 0.75.x auth/header compatibility, and small pure helper extractions only where they improve testability.

## Approach
1. **Keep the architecture stable.** `diligent-context` remains the sole owner of persisted diligent memory and synthetic checkpoint projection. `diligent-compact` remains the owner of visibility-aware compaction. `diligent-contemplate` remains the explicit semantic checkpoint generator. No `DiligentContextState` migration is part of this plan.
2. **Make contributor validation real but local.** Add a private root validation entrypoint around the existing Bun tests and update ignore hygiene. Do not add CI, publishing metadata, package exports, or a package wrapper.
3. **Make model defaults fresh but safe.** Keep the existing config shape recognizable, add an ignored local override layer, update shipped defaults using current official model docs, and make fallback to the current session model explicit to users.
4. **Harden by testing seams, not rewriting behavior.** Extract small pure helpers only where they make existing compaction routing/preparation or config behavior testable. Prefer regression tests around current invariants before runtime changes.
5. **Improve docs before adding automation.** Because distribution should stay as lightweight as possible, this pass should make manual install/update and local configuration clear. Installer scripts, package wrappers, CI, and release automation are deferred to a future plan if manual docs still prove too weak.

### Non-goals
- No package publishing or package-wrapper distribution.
- No CI-first workflow.
- No installer/sync script in this pass.
- No persisted diligent state schema change.
- No new Pi-core dependency or assistant-message persistence path.
- No degraded fallback that summarizes hidden history or writes speculative contemplation checkpoints.

## Work Items

### Item 1 — Add private local validation and repo hygiene

**Status:** Complete — `package.json` private scripts and `.gitignore` hygiene added; `bun test tests` and `bun run validate:local` passed.

**Goal:** Add a minimal contributor validation entrypoint without turning the repo into a distributable package.

**Decision / scope:** Add a root `package.json` with `private: true` and only local scripts, such as `test` and `validate:local`, around the existing Bun test suite. Do not add `main`, `exports`, `bin`, publishing metadata, CI, install automation, or TypeScript typechecking in this pass. Bun tests are the local validation floor; typechecking belongs in a future plan once Pi typings and dev dependencies are intentionally modeled.

**Done when:**
- `bun test tests` passes from the repo root.
- `bun run validate:local` passes from the repo root.
- `.gitignore` covers local/generated state such as `node_modules/`, local `.pi/` cache state, debug artifacts, and `extensions/diligent-compact/config.local.json`.
- No runtime extension behavior changes are required for this item.

**Key files:** `package.json` (new), `.gitignore`.

**Dependencies:** None.

**Size:** S.

### Item 2 — Implement layered model config with explicit selection diagnostics

**Status:** Complete — layered config, auth/header-aware selection diagnostics, Pi 0.75 native compaction argument ordering, compact/contemplate config docs, and shared tests landed; `bun test tests` and `bun run validate:local` passed; Oracle review happy.

**Goal:** Make opinionated compaction and contemplation model selection fresh, robust, and understandable while preserving fallback to the current session model.

**Decision / scope:** Keep the existing config shape in `extensions/diligent-compact/config.json`, but load it as one layer over in-code defaults and under an ignored `config.local.json` resolved from the installed extension directory. In source and in an installed copy, that means the directory containing `extensions/diligent-compact/shared.ts` at runtime (`EXTENSION_DIR` today), so users edit `~/.pi/agent/extensions/diligent-compact/config.local.json` for user-level installs or `<project>/.pi/extensions/diligent-compact/config.local.json` for project-local installs. Ship `config.local.example.json` beside the committed config as documentation-by-example. Invalid local config should warn and fall back, not crash extension import.

**Recommended model posture:** Update both `DEFAULT_CONFIG` and committed `config.json` to this exact committed candidate order, intentionally preserving the repo’s existing Anthropic-first posture to avoid surprising existing users while refreshing model IDs:
1. `anthropic/claude-opus-4-7` with `thinkingLevel: "xhigh"`.
2. `openai-codex/gpt-5.5` with `thinkingLevel: "xhigh"`.
3. `openai-codex/gpt-5.4` with `thinkingLevel: "xhigh"`.
4. `anthropic/claude-sonnet-4-6` with `thinkingLevel: "high"`.
5. Current session model fallback as the final runtime fallback.

Implementation should verify candidate availability against the current Pi model registry and skip unavailable candidates/API keys at runtime, but it should not reorder the committed defaults or tune thinking levels without a new explicit decision.

**Config merge semantics:**
- Missing `compactionModels` inherits the prior layer.
- Empty `compactionModels: []` intentionally disables configured candidates for that layer and uses current-model fallback only.
- A non-empty `compactionModels` list with at least one valid `{ provider, id }` replaces the prior layer.
- A non-empty `compactionModels` list with zero valid entries is ignored and recorded as a diagnostic so a typo does not erase all configured fallbacks.
- Invalid `thinkingLevel` or `debugCompactions` values are ignored and recorded as diagnostics.
- `config.local.json` wins over `config.json` using the same rules.

**Testable config seam:** Add a pure loader/normalizer that tests can call without mutating real files or relying on import-cache behavior, such as `loadExtensionConfigFromLayers(layers) -> { config, diagnostics }`. Runtime file reading can continue to build the same layer inputs from `DEFAULT_CONFIG`, installed-directory `config.json`, and optional installed-directory `config.local.json`.

**Selection behavior:** Replace the implicit selected-or-null result with a testable selection result shape:

- `selected: null | { model, auth: { apiKey?: string; headers?: Record<string, string> }, thinkingLevel, source: "configured" | "current-model", configuredModel?: CompactionModelConfig }`
- `skippedConfiguredModels: Array<{ provider: string; id: string; reason: "not-registered" | "missing-auth" | "auth-error"; message?: string }>`
- `configDiagnostics: ConfigDiagnostic[]`

Model lookup/auth should prefer current Pi APIs when available: `modelRegistry.find(provider, id)` before broad scans, and `modelRegistry.getApiKeyAndHeaders(model)` before legacy provider-key fallbacks. Treat auth as usable when `getApiKeyAndHeaders(...)` returns `ok: true` with either `apiKey` or `headers`; record `auth-error` diagnostics/debug metadata when it returns `ok: false`. Preserve request headers in both `completeSimple(...)` and native compatibility compaction.

Config-load diagnostics should be collected without UI side effects at module import time, then returned through the selection result and surfaced once per explicit opinionated operation through existing `notify` paths or debug logging if no UI is available. Opinionated compaction and contemplation should emit one concise warning when configured candidates are skipped and current-model fallback is used. Compatibility `/compact` should not warn, because it intentionally follows Pi’s current-model behavior.

**Pi 0.75.x compatibility requirement:** Update compatibility compaction to call current native `compact(...)` as `compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn?)`. `session_before_compact` should pass `pi.getThinkingLevel()` into `runCompatibilityCompactionRequest(...)`, and tests should capture positional arguments so the old unsafe call shape cannot regress.

**Done when:**
- Missing or invalid `config.json`/`config.local.json` cannot crash extension import.
- `config.local.json` can override committed defaults without being committed.
- Configured selection still prefers the first registered candidate with usable auth (`apiKey` and/or request headers).
- If configured candidates are unavailable, the current session model fallback remains available and is clearly reported.
- Compatibility compaction forwards current-model auth headers, custom instructions, abort signal, and thinking level into the correct current Pi native `compact(...)` argument slots.
- `diligent-compact` and `diligent-contemplate` use the updated metadata without changing their core fail-closed behavior.
- Shared tests cover the pure config loader seam, config layering, invalid config, local overrides, candidate ordering, unavailable candidates, missing auth, auth errors, request headers, collected diagnostics, fallback source metadata, and native compatibility compaction argument ordering.
- The compact/contemplate config docs that name the installed `config.local.json` paths land in the same change set as this behavior; the broader README/contributor cleanup can wait for Item 6.

**Key files:** `extensions/diligent-compact/shared.ts`, `extensions/diligent-compact/config.json`, `extensions/diligent-compact/config.local.example.json` (new), `extensions/diligent-compact/index.ts`, `extensions/diligent-contemplate/index.ts`, `tests/diligent-compact-shared.test.ts`, `.gitignore`.

**Dependencies:** Item 1.

**Size:** M.

### Item 3 — Extract compaction visibility/preparation seams for tests

**Status:** Complete — pure visibility/preparation/alignment helpers extracted to `extensions/diligent-compact/visibility.ts`, tests added, `index.ts` delegates behavior-preserving seams, `bun test tests` and `bun run validate:local` passed; Oracle review happy.

**Goal:** Make the visibility-aware compaction route matrix, raw/session alignment, first-kept mapping, and checkpoint carry-forward behavior directly testable without changing runtime behavior.

**Decision / scope:** Add a pure module, tentatively `extensions/diligent-compact/visibility.ts`, and move existing synchronous transformation/diagnostic helpers out of `index.ts`. Keep UI notifications, file writes, pending request state, model calls, command registration, and Pi event orchestration in `index.ts`.

**Seams to move or expose:**
- `computeCompactionRoute(args: { pendingMode?: "opinionated" | "force-native"; diligentEnabled: boolean }): "native" | "compatibility" | "opinionated" | "force-native"`, where pending `force-native` beats pending `opinionated`, which beats diligent-enabled `compatibility`, which beats `native`.
- Existing preparation result and diagnostic types, including `VisiblePreparationBuildResult`, `VisiblePreparationFailureDiagnostic`, `AlignmentDivergenceDiagnostic`, `AlignmentStats`, and `DiagnosticMessageSummary`.
- `alignRawMessagesToContextEntries(...)` and its diagnostic helpers.
- `buildVisiblePreparation(...)`, `computeFirstKeptVisibleIndex(...)`, and `findPreferredVisibleCutIndex(...)`.
- Visible file-op extraction helpers.
- Checkpoint `previousSummary` construction.
- Visible-preparation failure reasons and diagnostic summaries.

**Done when:**
- `extensions/diligent-compact/index.ts` delegates pure route/preparation/alignment work to the new module.
- Runtime route behavior is unchanged.
- Tests cover route matrix, no live payload, restoring/lost anchor, filtered-to-raw mismatch, raw/context mismatch diagnostics, first-kept entry id mapping, nothing visible to compact, checkpoint `previousSummary`, and projected-checkpoint token accounting.
- Existing lost-anchor recovery and shared compaction tests still pass.

**Key files:** `extensions/diligent-compact/visibility.ts` (new), `extensions/diligent-compact/index.ts`, `tests/diligent-compact-visibility.test.ts` (new), `tests/diligent-context-recovery.test.ts` if expectations need adjustment.

**Dependencies:** Item 1. Can run before or after Item 2; if after Item 2, keep model-selection mocks aligned.

**Size:** L.

### Item 4 — Lock down `diligent-context` checkpoint and projection invariants

**Status:** Complete — checkpoint/projection invariants added across core and recovery tests; no state schema changes; `bun test tests` and `bun run validate:local` passed; Oracle review happy.

**Goal:** Turn the documented `diligent-context` invariants into regression coverage so future polish work cannot accidentally contaminate real snapshots, retain stale checkpoints, or drift from persisted-state authority.

**Decision / scope:** Prefer tests against existing exported pure helpers and the existing recovery harness. Modify runtime code only if tests expose a real invariant bug. Do not add fields to `DiligentContextState`.

**Coverage to add:**
- `normalizeState(...)` rejects legacy `keepLast` / `anchorEntryId` shapes and invalid enabled states.
- `pending-here` normalizes/materializes without active checkpoints.
- `buildRuntimeSnapshotFromRawMessages(...)` never includes synthetic checkpoint messages in `rawMessages`, `filteredMessages`, or `filteredToRawIndices`.
- The `context` hook may return projected checkpoint messages while the stored runtime snapshot remains grounded in real raw/filtered messages.
- Manual re-anchor clears contemplation and regenerates or reconciles provenance.
- `session_compact` clears active checkpoints by appending updated diligent state.
- Lost-anchor recovery does not preserve stale checkpoints from a lost boundary.

**Done when:**
- The above invariants are covered by Bun tests.
- Existing provenance, pruning, and recovery tests still pass.
- Any fixes are limited to the current owner helpers/hooks and preserve the state schema.

**Key files:** `tests/diligent-context-core.test.ts`, `tests/diligent-context-recovery.test.ts`, `extensions/diligent-context/core.ts` only if needed, `extensions/diligent-context/index.ts` only if needed.

**Dependencies:** Item 1 for pure core tests. Run Item 3 before changing recovery-harness assertions in this item, so compaction extraction and recovery expectations do not collide.

**Size:** M.

### Item 5 — Add `diligent-contemplate` command safety coverage

**Status:** Complete — command harness covers unsafe no-write paths, stale/session mutation guards, strict recomputed visible mapping validation, headers-only auth, and successful checkpoint writes; `bun test tests` and `bun run validate:local` passed; Oracle review happy.

**Goal:** Cover the highest-risk `/diligent-contemplate` paths: write nothing on unsafe inputs, write the right state on success, and abort cleanly when live context or session identity changes mid-generation.

**Decision / scope:** Test through the registered command handler using a harness similar to `tests/diligent-context-recovery.test.ts`. Mock `@mariozechner/pi-ai.completeSimple`, `convertToLlm`, `serializeConversation`, model registry API-key methods, `appendEntry`, `sendMessage`, and `notify`. Do not create a new contemplation core module unless the harness proves unworkable. Preserve the current no-degraded-fallback posture.

**Scenarios to cover:**
- No active session, no runtime snapshot, invalid visible mapping, lost/restoring anchor, duplicate active contemplation with no new messages, null model selection, prompt-budget failure, empty model output, live snapshot mutation after LLM response, active session change after LLM response, and stale Pi 0.75.x post-await context/session access all warn or abort cleanly and write nothing.
- Successful run appends one `DILIGENT_CONTEXT_CUSTOM_TYPE` state, anchors `after-entry`, includes a contemplation checkpoint with provider/model metadata, reconciles provenance, emits `DILIGENT_CHECKPOINT_CUSTOM_TYPE` custom messages, and updates the runtime snapshot from real raw messages.
- If Item 2 falls back to the current session model, the command emits one concise warning.

**Done when:**
- New contemplation tests pass under `bun test tests`.
- The command still cleans up in-flight state, abort controllers, and status in `finally`, with notify/status cleanup best-effort so stale UI/session access does not rethrow from `catch`/`finally`.
- No schema changes are made.
- Existing compact/context tests still pass.

**Key files:** `tests/diligent-contemplate.test.ts` (new), `extensions/diligent-contemplate/index.ts`, `tests/diligent-compact-shared.test.ts` if shared model-selection mocks need updates.

**Dependencies:** Items 1 and 2.

**Size:** M.

### Item 6 — Update user, contributor, and config documentation

**Status:** Complete — root README expanded, `CONTRIBUTING.md` and `CHANGELOG.md` added, compact/contemplate docs aligned with landed config and compatibility behavior, and docs preserve the copy-based/no-package-wrapper posture.

**Goal:** Make the repo usable by more users and contributors while keeping the distribution model copy-based and lightweight.

**Decision / scope:** Improve documentation rather than adding installer scripts or publishing. Root README remains the user entrypoint; contributor and changelog docs can be added as small public surfaces. Update docs after the corresponding behavior/tests land, so README and extension docs do not describe non-existent `config.local.json`, fallback warnings, or validation commands.

**Docs to update:**
- `README.md`: clarify what the extensions do, dependency ordering, manual install/update, `config.local.json`, model fallback behavior, local validation, current Pi package scope (`@earendil-works/*`) versus legacy loader aliases (`@mariozechner/*`), troubleshooting, debug artifact paths, and the no-package-wrapper posture.
- `CONTRIBUTING.md` (new): local validation command, testing/mocking conventions, invariant guardrails, fail-closed compaction rule, and “no publishing changes without a separate plan.”
- `CHANGELOG.md` (new): `Unreleased` section for readiness/polish changes.
- `extensions/diligent-compact/README.md`: layered config, default model candidates, auth/header-aware fallback warning behavior, current Pi native `compact(...)` compatibility posture, and unchanged route/failure posture.
- `extensions/diligent-contemplate/README.md`: inherited layered model config and no-write failure posture when no configured/current model is usable.
- `extensions/diligent-context/README.md`: only light alignment if needed; avoid duplicating the root README.

**Done when:**
- A new user can install manually without guessing dependency order.
- A user can update while preserving local model choices through `config.local.json`.
- A contributor can run local validation from the README or `CONTRIBUTING.md`.
- Docs explicitly say this polish pass does not change persisted diligent state schema.
- Docs do not imply CI, package publishing, or installer automation exists.

**Key files:** `README.md`, `CONTRIBUTING.md` (new), `CHANGELOG.md` (new), `extensions/diligent-compact/README.md`, `extensions/diligent-contemplate/README.md`, `extensions/diligent-context/README.md` if needed.

**Dependencies:** Items 1–5. The installed-path `config.local.json` docs listed in Item 2 should already be in place before this broader docs pass begins.

**Size:** M.

### Item 7 — Final local validation and readiness smoke checklist

**Status:** Complete — `bun run validate:local` passed on 2026-05-24 (`75 pass`, `0 fail`); real user-level Pi smoke was unavailable/not run in the final validation pass and is recorded as unavailable in `CHANGELOG.md`.

**Goal:** Close the implementation pass with repeatable validation and a small manual smoke checklist against a real Pi install when available.

**Decision / scope:** Validation remains local. The smoke checklist validates user-level behavior but does not require this repo to automate install/update.

**Checklist:**
- Run `bun run validate:local` from the repo root.
- Confirm ignored local artifacts are not staged.
- If a real Pi session is available, manually install/copy all three extension folders and smoke only the critical integration paths:
  1. `/diligent-compact` with configured candidates unavailable warns before current-model fallback.
  2. `/diligent-compact --force-native` warns that visibility guarantees are bypassed.
  3. `/diligent-contemplate` emits a checkpoint artifact and re-anchors after represented real visible payload.
  4. A successful compaction after active checkpoints clears them.

**Done when:**
- All local tests pass.
- Manual smoke results are recorded in the changelog or implementation summary, or the implementation notes explicitly say smoke was unavailable.
- No generated debug artifacts, local config, dependency folders, or read caches are staged.
- No package publishing, CI, installer automation files, or prompt-export artifacts are introduced.

**Key files:** `CHANGELOG.md`, implementation summary/handoff notes, and this plan only if the implementation team chooses to record final validation here.

**Dependencies:** Items 1–6.

**Size:** S.

## Risks and Guardrails
- **Persisted state compatibility:** Do not add fields to `DiligentContextState` or change custom entry types. Any discovered invariant bug should be fixed inside current owner helpers/hooks.
- **Config overwrite risk:** Copy-based installs can overwrite `config.json`; docs and `config.local.json` are the mitigation in this lightweight pass.
- **Model availability drift:** Model IDs are time-sensitive and Pi-registry-dependent. Runtime selection should validate configured candidates against the current Pi model registry and skip unavailable candidates or missing API keys cleanly. The committed defaults are fixed by Item 2 unless a separate explicit decision updates them.
- **Extraction drift:** Moving compaction preparation helpers out of `index.ts` risks subtle behavior changes. Mitigate by moving functions first, adding tests around current behavior, and keeping UI/file/model/event side effects in `index.ts`.
- **Mock-only confidence:** Bun tests do not replace real Pi runtime smoke. Keep fail-closed behavior and run the manual checklist when possible.

## Open Questions
None blocking. The user has already resolved the plan-shaping DX choices: lightweight distribution, local-only validation, and layered model fallback.

## References
- `README.md`
- `extensions/diligent-context/spec.md`
- `extensions/diligent-context/core.ts`
- `extensions/diligent-context/index.ts`
- `extensions/diligent-compact/README.md`
- `extensions/diligent-compact/index.ts`
- `extensions/diligent-compact/shared.ts`
- `extensions/diligent-compact/config.json`
- `extensions/diligent-contemplate/README.md`
- `extensions/diligent-contemplate/index.ts`
- `tests/diligent-compact-shared.test.ts`
- `tests/diligent-context-core.test.ts`
- `tests/diligent-context-recovery.test.ts`
- OpenAI Models: https://developers.openai.com/api/docs/models
- Anthropic Models Overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic Model IDs and Versioning: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
