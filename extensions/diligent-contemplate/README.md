# diligent-contemplate

`/diligent-contemplate [custom prompt]` creates a visibility-aware **contemplation checkpoint**.

It uses:
- the same diligent-visible live context universe as `diligent-compact`
- the same opinionated model-selection stack configured in `diligent-compact/config.json`
- any active diligent checkpoints as structured carry-forward context

Then it:
1. generates a contemplation checkpoint body
2. stores that checkpoint inside `diligent-context` state
3. emits a visible checkpoint artifact into the chat transcript as a `custom_message`
4. moves `diligent-context` to **after the last real visible message represented by the checkpoint**

## Why this exists

Sometimes we want to preserve a compact memory checkpoint before hiding more tool chatter.

`diligent-contemplate` is the deliberate reflection step for that moment.

## Command

### `/diligent-contemplate [custom prompt]`
Generate a contemplation checkpoint from the current diligent-visible live payload.

Any trailing text is passed as extra focus instructions.

## Failure posture

The command fails fast and writes nothing when:
- no current diligent-visible live payload exists yet
- the diligent boundary is still restoring
- nothing new has happened since the active contemplation checkpoint
- the visible live payload changed while the checkpoint was generating
- no configured model/API key is available
- the prompt exceeds the selected model's safe input budget
- the model returns empty output

There is no degraded fallback path.

## Prompt

Edit:

- `extensions/diligent-contemplate/contemplation-prompt.md`

## Model configuration

`diligent-contemplate` reuses:

- `extensions/diligent-compact/config.json`

So the configured compaction model order also controls contemplation.

## Persistence model

The contemplation result is **not** saved as a real assistant message.

Instead:
- `diligent-context` owns the active checkpoint inside persisted diligent state
- the human sees a visible custom checkpoint artifact in chat
- the model sees the checkpoint via diligent-context's context projection
- any successful compaction clears active checkpoints
