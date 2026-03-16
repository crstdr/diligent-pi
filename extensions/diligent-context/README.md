# diligent-context

## Purpose

`/diligent-context` reduces context bloat from stale tool chatter while preserving the human conversation.

The original rolling-window experiment proved the idea worked, but the first anchored redesign used **branch history** as the actionable source of truth. In practice that broke once Pi started sending a transformed live payload (for example with `compactionSummary` and remapped tool IDs).

The current design is therefore **payload-grounded**:
- the picker operates on the **live payload**
- the reclaim estimates are based on the **live payload**
- pruning is applied to the **same live payload**

This restores a 1:1 correlation between:
- what the user selects
- what the UI claims is reclaimable
- what actually gets removed from the outgoing context

---

## Design goals

1. **Stable cache boundary** — the pruning boundary should remain stationary until the user moves it
2. **Payload-truthful UX** — the picker should only promise savings that are actually reclaimable from the live payload
3. **Preserve conversation narrative** — normal user/assistant conversation must remain in context
4. **Prune only tool baggage** — only historical `toolCall` blocks and matching `toolResult` messages should be removed
5. **Safe by default** — `/diligent-context` without arguments should inspect/control state, not mutate it implicitly
6. **Fail safe** — if the selected anchor is no longer present in live payload, prune nothing rather than guessing

---

## Non-goals

- No rolling `keepLast N` mode
- No automatic task-boundary inference
- No pruning of normal conversation history
- No branch-history reconciliation heuristics for actionable pruning

Branch/session history remains useful for rationale and persistence, but **not** as the actionable pruning universe.

---

## Command UX

### `/diligent-context`

Opens a control menu and shows current state.

It must not change anything by default.

Menu actions:

1. **Set boundary here**
2. **Pick boundary from live context**
3. **Turn off**
4. **Cancel**

### `/diligent-context here`

Sets the boundary **after the current live payload**.

Semantics:
- all existing live tool calls/results become prunable
- only future tool calls/results are retained from that point onward

If no cached live payload exists yet (for example right after `/resume`), this command stores a pending intent instead of warning. The footer shows `anchor:pending`, and the anchor materializes automatically on the next real model call once a stable live payload tail exists.

This is the fast path for “start fresh from here.”

### `/diligent-context off`

Disables diligent-context entirely and keeps all tool calls/results in context.

### `/diligent-context pick`

Opens the live-context picker directly.

This is a shortcut for opening `/diligent-context` and choosing **Pick boundary from live context**.

---

## Picker UX

The picker uses the **cached live payload** from the last model call.

If no live payload has been seen yet, the picker will not open and instead asks the user to send a message first.

### First-level picker

The first-level list shows:
- single narrative payload entries directly
  - user messages
  - assistant messages with meaningful text
  - compaction summaries when present in live payload
- collapsed tool bursts for contiguous tool-heavy assistant activity

### Second-level picker

If the user selects a tool burst, open a second-level picker scoped to the exact entries inside that burst.

This preserves exact-entry precision without forcing the user to scan a flat list of low-signal tool rows.

### Picker labels and estimates

The picker also displays **live reclaim estimates**:
- the header dynamically shows the cumulative tokens reclaimed if the highlighted entry is selected
- individual entries show their reclaimed token value in the description column (rendered in red)
- tool bursts show their own total token weight within the label

These estimates are derived from the current live payload, not from full branch history.

### Selection semantics

When the user selects a narrative entry in the first-level picker:
- that selected payload entry is **kept**
- tool context is retained **from that live entry onward**
- older live tool calls/results are pruned

When the user selects a tool burst in the first-level picker:
- open the second-level exact-entry picker for that burst
- the final exact-entry selection is **kept**
- tool context is retained **from that exact live entry onward**
- older live tool calls/results are pruned

---

## State model

The old rolling state:

```ts
{
  enabled: boolean;
  keepLast: number;
}
```

and the later branch-anchored state:

```ts
{
  enabled: boolean;
  anchorEntryId: string | null;
  anchorMode: "from-entry" | "after-entry" | null;
}
```

are replaced with a **payload-grounded anchor state**:

```ts
{
  enabled: boolean;
  anchorMode: "from-entry" | "after-entry" | "pending-here" | null;
  anchorFingerprint: {
    role: string;
    textPrefix: string | null;
    toolNames: string[] | null;
    toolCount: number;
    payloadIndex: number;
  } | null;
}
```

### Meaning

- `enabled = false` → no pruning
- `anchorMode = "from-entry"` + `anchorFingerprint` → keep tool context starting at the selected live payload entry
- `anchorMode = "after-entry"` + `anchorFingerprint` → keep tool context strictly after the selected live payload tail (`/diligent-context here`)
- `anchorMode = "pending-here"` + `anchorFingerprint = null` → deferred `/diligent-context here`, waiting for the next stable live payload tail to materialize the real anchor

### Why a fingerprint, not branch entry IDs

Live payload messages do not reliably share tool-call IDs with branch history. In production we observed:
- non-empty prune sets derived from branch history
- non-empty payload tool IDs
- **zero overlap** between them

So actionable pruning must resolve against the live payload itself.

---

## Filtering semantics

The `context` hook shapes what the model sees.

### Invariants

Never prune:
- user messages
- assistant text blocks
- normal conversational content
- the latest assistant message if it contains `thinking` or `redacted_thinking` blocks

Only prune:
- assistant `toolCall` blocks
- `toolResult` messages linked to those tool calls

### Core rule

For the current live payload and current anchor:
- resolve the selected payload boundary using the stored fingerprint
- collect tool-call IDs from live payload messages **before** that boundary
- remove those tool calls and matching tool results from the outgoing model context

### Failure handling

If the selected anchor cannot be resolved in the current live payload:
- fail safe
- prune nothing
- log that the anchor is likely already compacted away or otherwise absent from live payload

This applies to both picked anchors and `/diligent-context here` once its remembered tail marker has aged out of live payload.

Over-including context is safer than over-pruning.

---

## Anthropic `thinking` block invariant

Anthropic's API requires that the latest assistant message containing `thinking` or `redacted_thinking` blocks remains unmodified.

So the context hook must:
- preserve that final assistant message exactly
- preserve its matching `toolResult` messages as well

Otherwise the request becomes invalid and the provider returns a `400 Bad Request`.

---

## Payload ID stability diagnostic

The implementation logs a small stability diagnostic between consecutive payloads:

- previous payload tool-ID count
- current payload tool-ID count
- stable overlap count

This helps determine whether payload-native IDs remain stable across calls or whether future tightening of fingerprint resolution is needed.

---

## Extension layout

```
extensions/diligent-context/
├── index.ts    — runtime extension
├── README.md   — feature spec (this file)
└── spec.md     — rationale and decision history
```
