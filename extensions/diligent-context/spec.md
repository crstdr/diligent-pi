# diligent-context spec notes

## Current posture

`diligent-context` is the owner of the live pruning boundary **and** of any lightweight checkpoint artifacts that must survive beyond that boundary.

This is a payload-grounded system:
- live payload is the actionable pruning universe
- branch/session history is used for persistence and restoration only
- synthetic checkpoint projection never contaminates the real payload snapshot

## Why checkpoint ownership lives here

Checkpoints only make sense relative to the active diligent boundary.

Putting them in `diligent-context` keeps these decisions in one place:
- what is hidden
- what is represented in lightweight form
- what the model still sees
- what gets cleared when the boundary changes or compaction happens

## Checkpoint kinds

### Provenance checkpoint
- deterministic within its recognized tool surfaces
- success-aware: derived from recognized file-touching tool activity plus successful tool results in the hidden prefix
- compact and factual
- conservative by design: unsupported commands are omitted rather than guessed
- no LLM involvement

### Contemplation checkpoint
- LLM-authored
- produced explicitly by `/diligent-contemplate`
- summarizes the work so far and folds forward prior checkpoints when present

## Invariants

1. Persisted diligent state is authoritative.
2. Runtime snapshots are caches only.
3. Synthetic checkpoint messages are projected only in the `context` return path.
4. Synthetic checkpoint messages never enter:
   - `rawMessages`
   - `filteredMessages`
   - `filteredToRawIndices`
5. Manual re-anchoring regenerates provenance and clears contemplation.
6. Any successful compaction clears active checkpoints.
7. `pending-here` never coexists with active checkpoints.

## Branch/session restoration

Branch restoration is state-driven.

When switching across `/tree`, `/fork`, session switch, or session start:
- diligent state is reloaded from the current branch
- cached runtime snapshot is discarded unless it can be safely rebuilt from raw payload plus persisted state

This prevents later branch state from leaking backward.

## Relationship to diligent-compact

`diligent-compact` consumes active checkpoints as structured carry-forward input.
It does not treat them as ordinary history messages.

That preserves the clean split:
- real payload snapshot for alignment and pruning
- checkpoint summary for semantic continuity
