# diligent-context

## Purpose

`/diligent-context` reduces context bloat from stale tool chatter while preserving the human conversation.

The design is **payload-grounded**:
- the picker operates on the **live payload**
- reclaim estimates are based on the **live payload**
- pruning is applied to the **same live payload**

This keeps the UX honest: what the user selects is what the model actually stops seeing.

---

## Design goals

1. **Stable cache boundary** — the pruning boundary remains stationary until the user moves it
2. **Payload-truthful UX** — reclaim estimates match real prunable payload
3. **Preserve conversation narrative** — normal user/assistant conversation stays in context
4. **Prune only tool baggage** — only historical `toolCall` blocks and matching `toolResult` messages are removed
5. **Checkpoint ownership** — lightweight memory artifacts that survive beyond the boundary belong to `diligent-context`
6. **Fail safe** — if the anchor can no longer be resolved, prune nothing rather than guessing

---

## Commands

### `/diligent-context`
Open the control menu.

### `/diligent-context here`
Set the boundary after the current live payload tail.

If there is no live payload yet, the command stores a `pending-here` intent and materializes it on the next real model call.

### `/diligent-context pick`
Pick a boundary from the current live payload.

### `/diligent-context off`
Disable diligent-context and clear active checkpoints.

---

## Checkpoints

`diligent-context` owns the lightweight artifacts that survive beyond the hidden prefix.

Current checkpoint kinds:
- `provenance` — deterministic file-touch residue from the hidden prefix
- `contemplation` — semantic memory checkpoint produced by `/diligent-contemplate`

### Visibility model

Each active checkpoint has two surfaces:

1. **Chat-visible**
   - checkpoint creation emits a visible `custom_message`
   - this gives the human an inspectable transcript artifact

2. **Model-visible**
   - active checkpoints are injected only in the `context` return path
   - synthetic checkpoint messages never enter the runtime snapshot
   - compaction and alignment logic therefore stay grounded in real payload only

### Lifecycle rules

- manual re-anchoring regenerates provenance and clears contemplation
- `/diligent-context off` clears all checkpoints
- `pending-here` never coexists with active checkpoints
- any successful compaction clears active checkpoints
- persisted diligent state restores checkpoints on branch/session restoration

---

## State model

```ts
{
  enabled: boolean;
  anchorMode: "from-entry" | "after-entry" | "pending-here" | null;
  anchorFingerprint: {
    role: string;
    textPrefix: string | null;
    toolNames: string[] | null;
    toolCount: number;
    toolResultId?: string | null;
    payloadIndex: number;
  } | null;
  checkpoints: {
    provenance: DiligentCheckpointArtifact | null;
    contemplation: DiligentCheckpointArtifact | null;
  };
}
```

Persisted diligent state is authoritative.

Runtime snapshots are caches only. If cached runtime state diverges from persisted state, diligent-context rebuilds the snapshot from raw payload plus persisted state.

---

## Filtering semantics

The `context` hook shapes what the model sees.

### Never prune
- user messages
- assistant text blocks
- normal conversation history
- the latest assistant message if it contains `thinking` / `redacted_thinking`

### Only prune
- assistant `toolCall` blocks
- matching `toolResult` messages

### Checkpoint invariant
Synthetic checkpoint messages are projected only at the context boundary.
They must never pollute:
- `rawMessages`
- `filteredMessages`
- `filteredToRawIndices`

That invariant keeps `diligent-compact` and turn-end alignment reliable.

---

## Extension layout

```text
extensions/diligent-context/
├── core.ts     — state model, checkpoint helpers, payload logic
├── index.ts    — runtime extension
├── README.md   — feature spec
└── spec.md     — rationale and decision history
```
