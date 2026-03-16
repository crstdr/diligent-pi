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

So `diligent-compact` uses the **current live visible payload** as the compaction universe when compaction is extension-managed.

## Routing model

On `session_before_compact`, the extension chooses one of three routes:

### 1. Native
If `diligent-context` is off and no explicit `/diligent-compact` request is active:
- the extension returns nothing
- Pi runs built-in `/compact` normally

### 2. Compatibility
If `diligent-context` is active:
- the extension builds a synthetic compaction preparation from the **current diligent-visible live payload**
- summarizes only the older visible prefix
- keeps the recent visible suffix untouched
- then calls Pi's exported native `compact(...)` helper on that synthetic preparation

This keeps `/compact` as the default command while making compaction see the same universe as normal model usage.

### 3. Opinionated
If the user explicitly runs `/diligent-compact`:
- the extension arms a one-shot request
- triggers compaction via `ctx.compact(...)`
- then compacts the same live visible payload universe with its configured model/prompt/thinking stack

## Commands

### `/compact`
Use Pi's default compaction command.

When `diligent-context` has a resolved anchor, the extension transparently routes `/compact` through the compatibility path so compaction summarizes only the live visible prefix, not a larger hidden backlog.

### `/diligent-compact [instructions]`
Run the explicit custom compaction path with the configured model/prompt stack.

Any trailing text is forwarded as compaction focus instructions.

### `/diligent-compact --force-native [instructions]`
Run one explicit degraded native compaction.

This is the escape hatch when visibility-aware alignment fails on an older or unusual session. It deliberately bypasses diligent-context visibility guarantees for that one compaction run, so hidden pre-anchor context may be summarized.

## Live-payload rule

When compaction is extension-managed, the source universe is:

- the current `diligent-context` filtered live payload

That means:
- no slice-proof classification
- no fingerprint-matching backlog slices back into the payload
- no separate `previousSummary` carry-forward in diligent-visible mode

If a previous compaction summary is still visible, it is already part of the live payload and will be summarized like any other visible message.

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

`config.json` affects the explicit `/diligent-compact` path.
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

(Artifacts can still contain sensitive conversation material; treat them as sensitive and do not share.)
