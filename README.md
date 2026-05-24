# diligent-pi

A small collection of Pi extensions focused on **careful context shaping** and **extension-owned memory checkpoints** rather than maximal automation.

This repo is the canonical source of truth for the diligent extensions. Downstream projects should vendor or copy from here rather than becoming the primary implementation surface.

## Extensions

Install the extensions together in dependency order:

1. **diligent-context** — owns the pruning boundary, hides stale tool chatter from the live model payload, preserves human conversation, and persists boundary-surviving checkpoints.
2. **diligent-compact** — keeps `/compact` and explicit `/diligent-compact` aligned with the same diligent-visible universe the model sees, carrying active checkpoints forward as structured summary input.
3. **diligent-contemplate** — explicitly generates semantic contemplation checkpoints, stores them through `diligent-context`, and re-anchors after the represented real visible payload.

Dependency notes:

- `diligent-compact` depends on shared helpers from `diligent-context/core.ts`.
- `diligent-contemplate` depends on both `diligent-context` and `diligent-compact/shared.ts`.
- If you only want pruning and visibility-aware compaction, install `diligent-context` and `diligent-compact` together.
- If you want contemplation checkpoints, install all three folders.

## Install

Distribution is intentionally copy-based and lightweight for now. There is no package wrapper, installer script, release automation, or CI-backed publish flow in this repo.

Copy the extension folders into one of Pi's extension directories:

- `~/.pi/agent/extensions/` for user-level use, or
- `<your-project>/.pi/extensions/` for project-local use.

User-level install example:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R extensions/diligent-context ~/.pi/agent/extensions/
cp -R extensions/diligent-compact ~/.pi/agent/extensions/
cp -R extensions/diligent-contemplate ~/.pi/agent/extensions/
```

Project-local install example:

```bash
mkdir -p <your-project>/.pi/extensions
cp -R extensions/diligent-context <your-project>/.pi/extensions/
cp -R extensions/diligent-compact <your-project>/.pi/extensions/
cp -R extensions/diligent-contemplate <your-project>/.pi/extensions/
```

Current Pi packages use the `@earendil-works/*` scope. Some extension imports still use legacy `@mariozechner/*` names because the current Pi extension loader provides those compatibility aliases.

## Update

To update an installed copy, copy the extension folders from this repo again.

Local model choices should live in `config.local.json` inside the installed `diligent-compact` directory. That file is git-ignored here and is not shipped by the repo, so normal copy updates do not overwrite it unless you delete the installed extension directory yourself.

Note that `cp -R` updates and adds files but may leave stale files behind if a future release removes or renames files. If you want a pruned mirror, use a delete-aware copy such as `rsync --delete` while excluding local state like `diligent-compact/config.local.json` and `diligent-compact/compactions/`.

If you remove installed folders before copying, back up and restore:

- `~/.pi/agent/extensions/diligent-compact/config.local.json`, or
- `<your-project>/.pi/extensions/diligent-compact/config.local.json`.

## Commands

### diligent-context

- `/diligent-context` — open the control menu.
- `/diligent-context here` — set the boundary after the current live payload tail, or store a pending intent if no live payload exists yet.
- `/diligent-context pick` — pick a boundary from the current live payload.
- `/diligent-context off` — disable diligent-context and clear active checkpoints.

### diligent-compact

- `/compact` — use Pi's normal compaction command; when `diligent-context` is active, this is routed through a visibility-aware compatibility path.
- `/diligent-compact [instructions]` — run the explicit opinionated compaction path using the configured model/prompt/thinking stack.
- `/diligent-compact --force-native [instructions]` — one-shot native override that intentionally bypasses diligent visibility guarantees.

### diligent-contemplate

- `/diligent-contemplate [custom prompt]` — generate a contemplation checkpoint from the current diligent-visible live payload.

## Model configuration

`diligent-compact` owns the shared opinionated model configuration used by both explicit `/diligent-compact` and `/diligent-contemplate`.

Configuration is layered:

1. in-code defaults,
2. shipped `extensions/diligent-compact/config.json`,
3. ignored local override `config.local.json` in the installed `diligent-compact` directory.

To customize a user-level install:

```bash
cp ~/.pi/agent/extensions/diligent-compact/config.local.example.json \
  ~/.pi/agent/extensions/diligent-compact/config.local.json
```

To customize a project-local install:

```bash
cp <your-project>/.pi/extensions/diligent-compact/config.local.example.json \
  <your-project>/.pi/extensions/diligent-compact/config.local.json
```

The shipped candidate order is:

1. `anthropic/claude-opus-4-7` with `thinkingLevel: "xhigh"`
2. `openai-codex/gpt-5.5` with `thinkingLevel: "xhigh"`
3. `openai-codex/gpt-5.4` with `thinkingLevel: "xhigh"`
4. `anthropic/claude-sonnet-4-6` with `thinkingLevel: "high"`
5. the current session model as the final runtime fallback

At runtime, configured candidates are checked against Pi's model registry and auth. Candidates are skipped if they are not registered, have no usable API key/request headers, or return an auth error. If all configured candidates are skipped, opinionated paths fall back to the current session model and emit one concise warning. Compatibility `/compact` intentionally follows Pi's current-model behavior.

Useful local override patterns:

- omit a field to inherit it from the prior layer;
- set `compactionModels: []` to intentionally use current-session fallback only;
- set `debugCompactions: true` to write additional debug artifacts.

Invalid local config warns and falls back instead of crashing extension import.

## Architecture invariants

- `diligent-context` owns the pruning boundary, persisted checkpoints, restoration, and checkpoint projection rules.
- Persisted diligent state is authoritative; runtime snapshots are caches only.
- Synthetic checkpoint messages are projected only in the `context` return path and never pollute real `rawMessages`, `filteredMessages`, or `filteredToRawIndices` snapshots.
- `diligent-compact` performs visibility-aware compaction over the same live visible universe the model sees.
- Active checkpoints are supplied to compaction as structured carry-forward input, not ordinary chat history.
- `diligent-contemplate` produces semantic checkpoints without relying on a Pi-core assistant-message persistence API.
- This polish pass does **not** change the persisted diligent state schema.

## Local validation

From the repo root:

```bash
bun run validate:local
```

That script currently runs the Bun test suite:

```bash
bun test tests
```

Validation is local-only in this repo. There is no CI workflow or package-publishing validation surface yet.

## Troubleshooting

### `/compact` is blocked while diligent-context is active

When `diligent-context` is active, `/compact` fails closed if the current visible live payload cannot be safely mapped back to session entries. This avoids summarizing hidden or speculative history. If you intentionally want to bypass visibility guarantees once, run:

```text
/diligent-compact --force-native [instructions]
```

### `/diligent-compact` falls back to the current model

This means every configured candidate was skipped because it was unavailable or lacked usable auth. Check Pi model auth and your installed `config.local.json`.

### `/diligent-contemplate` writes nothing

The command intentionally fails without writing state when there is no current diligent-visible payload, the boundary is restoring or lost, nothing new happened since the active contemplation checkpoint, model auth is unavailable, the prompt is too large, the model output is empty, or the live session changes mid-generation.

### Debug artifacts

Alignment diagnostics are written to:

- `~/.pi/agent/extensions/diligent-compact/compactions/latest-alignment-divergence.json`

If `debugCompactions` is enabled, additional timestamped artifacts and debug logs are written under:

- `~/.pi/agent/extensions/diligent-compact/compactions/`

Those artifacts are local/generated state and should not be committed.

## Manual smoke checklist

When a real Pi user-level install is available, copy all installed folders and smoke the critical paths:

1. `/diligent-compact` with configured candidates unavailable warns before current-model fallback.
2. `/diligent-compact --force-native` warns that visibility guarantees are bypassed.
3. `/diligent-contemplate` emits a checkpoint artifact and re-anchors after represented real visible payload.
4. A successful compaction after active checkpoints clears them.

Record whether this smoke was run in `CHANGELOG.md` or implementation notes before calling a polish pass complete.

## Notes

The extensions are stable enough to use, but the public distribution surface is still intentionally simple: copy folders, preserve local config, run local validation, and avoid treating downstream copies as canonical.