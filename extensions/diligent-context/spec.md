# diligent-context spec

## Status

This document captures the rationale and UX decisions behind the `diligent-context` extension so future developers can evolve it without losing the architectural intent.

### Layout

```
extensions/diligent-context/
├── index.ts    — runtime extension
├── README.md   — feature spec (commands, state model, filtering, picker UX)
└── spec.md     — rationale and decision history (this file)
```

---

## Why this extension exists

Pi sessions accumulate a lot of tool chatter:
- tool calls
- tool results
- browser snapshots
- tree listings
- large diffs
- code search output

That information is often useful **immediately**, but quickly becomes dead weight for later turns.

The architectural intent of `diligent-context` is therefore:

> preserve the human conversation, but selectively remove stale tool chatter from what the model sees.

This is a context-shaping feature, not a history-deletion feature.

### Core invariant

The extension must remain **non-destructive**:
- session history stays intact on disk
- branching / tree navigation keeps working
- only the outgoing model context is filtered

---

## What we learned from the first successful experiment

The first experiment used a **rolling window**:
- keep only the last `N` tool calls/results
- remove older tool chatter from model context

It worked and produced large context reductions in practice.

### Why the rolling model was replaced

Even though the rolling model worked technically, it had two architectural drawbacks:

1. the cutoff moved continuously, which weakened LLM cache reuse
2. it was count-based instead of task-based

Humans do not think in terms of “last 10/30/50 tool calls.”
They think in terms of:
- this mini-task started here
- this mini-task ended here
- everything before that is now mostly irrelevant tool chatter

That led to anchored pruning.

---

## Evolution of the anchored design

### Stage 1 — branch-grounded anchors

The first anchored redesign used:
- exact branch-entry anchors
- a branch-history-based picker
- branch-history token estimates

This seemed elegant because it matched the session tree model and preserved exact entry semantics.

### Why it failed in practice

Runtime diagnostics later proved the branch-grounded design was not trustworthy for actionable pruning.

We observed a real case where:
- the picker claimed roughly `~50k` reclaimable tokens
- the prune set was non-empty
- the live payload contained tool IDs
- but the overlap between branch-derived prune IDs and live payload tool IDs was **zero**

In other words:
- branch history knew about old tool chatter
- the live provider payload had already transformed or compacted that history
- pruning against branch-derived IDs became a silent no-op

This produced the worst kind of UX bug:
- the UI confidently promised savings
- the real payload did not change

### Architectural lesson

Actionable pruning must use the **same universe** as the actual outgoing model request.

That forced the pivot from branch-grounded to payload-grounded design.

---

## Current mental model

`diligent-context` is now a **payload-grounded anchor filter**.

### Meaning

- the picker is built from the **live payload**
- reclaim estimates are computed from the **live payload**
- pruning is applied to the **live payload**

This restores a 1:1 correlation between:
- what the user selects
- what the UI claims is reclaimable
- what actually gets removed

### Why this is better

It is more honest and more robust than branch-history reconciliation because it eliminates the need to bridge two different data universes.

---

## Key UX decisions and rationale

### Decision 1 — `/diligent-context` with no args must be non-mutating

We explicitly chose:
- `/diligent-context` opens control UI when interactive
- `/diligent-context` reports state/usage when non-interactive
- it must **not** silently change state by default

#### Why

A no-arg command should be safe and inspectable.

---

### Decision 2 — remove rolling mode entirely

We intentionally removed the old rolling `keepLast N` model instead of supporting both systems.

#### Why

A dual system would increase mental overhead and complexity without enough value.

---

### Decision 3 — `/diligent-context here` means “prune all current live tool chatter”

This command now acts against the current **live payload**, not the branch tip.

When no live payload exists yet (for example right after `/resume`), the extension records a deferred `pending-here` intent and materializes it on the next real context build instead of falling back to session state.

#### Why

That preserves the payload-grounded architecture without forcing the user to send a dummy message first.

---

### Decision 4 — preserve normal conversation, prune only tool baggage

We explicitly chose not to prune normal conversation before the boundary.

#### Why

The value is in preserving:
- intent
- decisions
- instructions
- narrative continuity

Those are usually much more valuable than historical tool logs.

---

### Decision 5 — do not hard-couple to Pi internals

We still reuse the **mental model** of `/tree`, but the extension remains self-contained.

#### Why

Undocumented Pi internals are too brittle to make the extension reliable long-term.

---

### Decision 6 — live payload is the only actionable source of truth

This is now the key architectural decision.

#### Why

Branch history can diverge materially from the actual outgoing payload because Pi may:
- compact older turns
- inject `compactionSummary`
- regenerate tool-call IDs
- otherwise reshape history before provider submission

So branch history is useful for documentation and reasoning, but **not** for truthful pruning UI.

---

## Picker evolution

### Stage A — flat exact-entry picker

The first anchored picker exposed a flat list of exact entries.

#### What was good
- precise
- direct
- technically correct inside a single universe

#### What was bad
- long flat lists became noisy
- repeated tool rows were low-signal
- mini-task structure was hard to see

---

### Stage B — visible selector fix

A real usability bug surfaced: moving up/down in the picker did not make the active row visually obvious in the user's theme.

We replaced the subtle default selector with a custom `SelectList` UI that has a clearly visible highlighted row.

#### Why

A picker without a clear active row is not shippable.

---

### Stage C — hybrid two-level picker

This remains the current interaction model, but now it is applied to the **live payload** instead of branch history.

#### First level
Show:
- narrative entries directly
- grouped tool bursts for contiguous tool-heavy assistant activity

#### Second level
Only if a tool burst is selected:
- open an exact-entry picker scoped to that burst

#### Why this is still the best UX

It balances:
- readability
- task-level grouping
- exact-entry precision

The important change is not the shape of the picker — it is the **truthfulness of the universe the picker reflects**.

---

## Tool burst rationale

A tool burst represents a contiguous run of assistant activity where the meaningful content is tool usage rather than narrative explanation.

### Why group bursts

Because low-level rows like:
- bash
- read
- edit
- grep
- write

often belong to a single mini-task.

Showing them flat hides the actual structure of the conversation.

### Why narrative entries stay visible

Narrative entries remain high-signal because they usually encode:
- the user's intent
- the assistant's explanation
- the boundary between mini-tasks

Those should stay directly selectable.

---

## Payload-grounded anchor resolution

### Current persisted anchor shape

The extension persists:
- `anchorMode`
- `anchorFingerprint`

The fingerprint includes:
- role
- text prefix
- tool names
- tool count
- payload index hint

For `/diligent-context here`, the implementation stores a fingerprint of the current live payload tail. If no live payload has been observed yet, the command records a deferred `pending-here` intent instead of creating a blind anchor.

### Why a fingerprint is needed

Even within the live payload universe, tool IDs may or may not remain stable across calls.

So we do two things:
1. log a small payload-ID stability diagnostic across consecutive context events
2. resolve the anchor using the fingerprint rather than trusting one payload-specific tool ID forever

### Fail-safe rule

If the selected anchor cannot be found in the next live payload:
- prune nothing
- log that the anchor is likely already compacted away or otherwise absent

#### Why

Over-including context is safer than over-pruning the wrong payload region.

---

## Anthropic `thinking` block invariant

The latest assistant message containing `thinking` or `redacted_thinking` blocks must remain unmodified.

So the context hook must:
- preserve that final assistant message exactly
- preserve its matching `toolResult` messages as well

#### Why

Anthropic rejects requests that mutate those blocks or leave dangling tool calls/results.

---

## Guardrails for future developers

If you modify this extension later, preserve these constraints unless there is a deliberate redesign:

1. **Never destroy session history**
   - filter model context only

2. **Preserve narrative conversation**
   - prune only tool chatter unless there is an intentional redesign

3. **Use the live payload as the actionable pruning universe**
   - do not regress to branch-history-based reclaim estimates for actual pruning

4. **Keep no-arg behavior safe**
   - inspection/control first, mutation only on explicit action

5. **Respect provider invariants**
   - especially Anthropic thinking/redacted_thinking handling

6. **Keep picker UX legible under real themes**
   - visible selection is mandatory

7. **Group tool chatter, but do not hide meaningful narrative boundaries**

8. **Fail safe when anchor resolution is uncertain**
   - over-include rather than over-prune

---

## Future improvement areas

### 1. Publish to GitHub

The extension is now folder-based and ready to be published as a standalone Pi extension.

### 2. Better live feedback after pruning

A future enhancement could surface the **actual removed payload size** after each context hook, not just the picker estimate.

### 3. Search/filter in picker

Could help very long live payloads, but is not necessary unless the picker becomes too noisy.

---

## One-sentence architectural summary

`diligent-context` is a non-destructive, payload-grounded context filter that preserves the human conversation while hiding stale tool chatter, using a task-aware two-level picker over the live payload so the UI's reclaim promises match what the model request can actually lose.
