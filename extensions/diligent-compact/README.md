# diligent-compact

A Pi extension that makes compaction **visibility-aware** when `diligent-context` is active, while also adding an explicit custom command:

- **`/compact`** stays the default Pi command
- **`/diligent-compact`** runs our opinionated compaction path

## Why this exists

`diligent-context` can hide stale historical tool chatter from the live payload.
If compaction summarized that hidden chatter anyway, we would:

- waste compaction budget on context the model would not otherwise see
- risk overfilling the compaction request itself
- reintroduce hidden tool churn as visible summary text

So `diligent-compact` coordinates compaction with the same visibility rules.

## Routing model

On `session_before_compact`, the extension chooses one of three routes:

### 1. Native
If `diligent-context` is off, pending, or unresolved:
- the extension returns nothing
- Pi runs built-in `/compact` normally

### 2. Compatibility
If the current compaction slice includes content hidden by `diligent-context`, or an older rolling summary can no longer be proven visibility-safe:
- the extension filters the slice to the **visible** subset
- drops unsafe old rolling summaries instead of carrying hidden context forward
- then calls Pi's exported native `compact(...)` helper on that corrected preparation

This keeps `/compact` as the default command while avoiding summaries of hidden context.

### 3. Opinionated
If the user explicitly runs `/diligent-compact`:
- the extension arms a one-shot request
- triggers compaction via `ctx.compact(...)`
- then performs custom compaction in `session_before_compact`

This opinionated path controls:
- model selection
- thinking level
- prompt body (`compaction-prompt.md`)

When a diligent anchor is active, the opinionated path uses the same visibility-safe slice classification before summarizing.

## Commands

### `/compact`
Use Pi's default compaction command.

When `diligent-context` has a resolved anchor, the extension transparently routes `/compact` through the compatibility path so the compaction input and rolling summary remain visibility-safe under that anchor. If the current slice contains hidden content, only the visible subset is summarized.

### `/diligent-compact [instructions]`
Run the explicit custom compaction path with the configured model/prompt stack.

Any trailing text is forwarded as compaction focus instructions.

## Visibility coordination

The extension reuses `diligent-context`'s shared payload-grounded core.
It classifies each compaction slice as:
- proven before the anchor
- proven after the anchor
- proven mixed across the anchor (safe via exact global ID filtering)
- unproven

Only proven slices can produce a visibility-safe rolling summary for the current anchor.
If proof fails while a diligent anchor is active, the extension blocks compaction rather than minting an unsafe summary.

## Prompt

Edit:

- `compaction-prompt.md`

The opinionated path reads this file at compaction time, so you can iterate on the prompt without changing code.

## Configuration

Edit:

- `extensions/diligent-compact/config.json`

Example:

```json
{
  "compactionModels": [
    { "provider": "openai-codex", "id": "gpt-5.4" },
    { "provider": "anthropic", "id": "claude-opus-4-6" }
  ],
  "thinkingLevel": "xhigh",
  "debugCompactions": false
}
```

## Failure posture

- If the diligent anchor is active but the compaction slice cannot be proven safely before/after that anchor, the extension cancels compaction rather than minting an unsafe rolling summary.
- If compatibility compaction fails after visibility-aware routing engaged, the extension cancels compaction rather than falling back to native `/compact` and summarizing hidden context.
- If an older rolling summary becomes unsafe under the current diligent anchor, the extension resets it once and then propagates anchor-scoped safety metadata forward.
- If opinionated compaction fails, the explicit `/diligent-compact` request is cancelled.
- If `diligent-context` is pending (`anchor:pending`), compaction does not speculate a future boundary.

## Debugging

If `debugCompactions` is enabled, artifacts are written to:

- `~/.pi/agent/extensions/diligent-compact/compactions/`

(Contains prompt inputs and outputs; treat as sensitive and do not share.)
