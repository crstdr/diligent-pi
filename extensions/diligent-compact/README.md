# diligent-compact

A Pi extension that makes compaction use the same live visible context universe the model sees during normal usage.

- **`/compact`** stays the default Pi command
- **`/diligent-compact`** runs the opinionated custom compaction path

## Why this exists

`diligent-context` can hide stale historical tool chatter from the live payload.
If compaction summarized a larger historical backlog than the model currently sees, we would:

- waste compaction budget on invisible history
- hit prompt-size failures even when the live context still fits
- reintroduce hidden tool churn as visible summary text

So `diligent-compact` uses the **current diligent-visible live payload** as the compaction universe when compaction is extension-managed.

## Routing model

On `session_before_compact`, the extension chooses one of four routes:

### 1. Native
If `diligent-context` is off and no explicit `/diligent-compact` request is active:
- the extension returns nothing
- Pi runs built-in `/compact` normally

### 2. Compatibility
If `diligent-context` is active:
- the extension builds a synthetic compaction preparation from the **current diligent-visible live payload**
- summarizes only the older visible prefix
- keeps the recent visible suffix untouched
- carries any active diligent checkpoints forward as structured summary input
- then calls Pi's exported native `compact(...)` helper on that synthetic preparation

### 3. Opinionated
If the user explicitly runs `/diligent-compact`:
- the extension arms a one-shot request
- triggers compaction via `ctx.compact(...)`
- then compacts the same live visible payload universe with its configured model/prompt/thinking stack
- active diligent checkpoints are supplied as structured carry-forward input, not as ordinary chat history

### 4. Force-native
`/diligent-compact --force-native` bypasses diligent visibility guarantees for one run.

This is the explicit escape hatch when visibility-aware alignment fails on an older or unusual session.

## Commands

### `/compact`
Use Pi's default compaction command.

When `diligent-context` has a resolved anchor, the extension transparently routes `/compact` through the compatibility path so compaction summarizes only the live visible prefix, not a larger hidden backlog.

### `/diligent-compact [instructions]`
Run the explicit custom compaction path with the configured model/prompt stack.

Any trailing text is forwarded as compaction focus instructions.

### `/diligent-compact --force-native [instructions]`
Run one explicit degraded native compaction.

## Checkpoint carry-forward

Active diligent checkpoints are **not** treated as ordinary message history for compaction.

Instead:
- the runtime snapshot stays grounded in real payload only
- active checkpoints are provided through `previousSummary`-style carry-forward input
- any successful compaction clears active checkpoints afterward

This prevents summary-of-summary drift while preserving semantic continuity.

## Prompt

Edit:

- `compaction-prompt.md`

The opinionated path reads this file at compaction time, so you can iterate on the prompt without changing code.

## Configuration

Edit:

- `extensions/diligent-compact/config.json`

`config.json` affects the explicit `/diligent-compact` path and the shared opinionated stack used by `/diligent-contemplate`.
The compatibility route behind `/compact` uses the current session model so it stays close to Pi's native compaction behavior.

## Failure posture

- If `diligent-context` is active but no current visible live payload is available yet (for example right after `/resume`), compaction fails fast with a clear warning.
- If the current live visible payload cannot be mapped back to session entries safely, compaction is cancelled rather than guessed.
- If there is no older visible prefix to summarize yet, compaction is cancelled rather than summarizing hidden or speculative history.
- If compatibility compaction fails after visibility-aware routing engaged, the extension cancels compaction rather than falling back to native `/compact` and summarizing hidden context.
- If opinionated compaction fails, the explicit `/diligent-compact` request is cancelled.
- The only override is `/diligent-compact --force-native`, which is explicit, one-shot, and intentionally suspends visibility guarantees for that run.

## Debugging

When live/session alignment fails, the extension always writes the latest divergence artifact with truncated comparison windows to:

- `~/.pi/agent/extensions/diligent-compact/compactions/latest-alignment-divergence.json`

If `debugCompactions` is enabled, additional timestamped artifacts are also written to:

- `~/.pi/agent/extensions/diligent-compact/compactions/`
