# diligent-pi

A small collection of Pi extensions focused on **careful context shaping** and **extension-owned memory checkpoints** rather than maximal automation.

This repo is the canonical source of truth for the diligent extensions.

Current extensions:

- **diligent-context** — hide stale tool chatter from the live payload while preserving the human conversation, and own boundary-surviving checkpoints
- **diligent-compact** — keep compaction aligned with the context that remains visible under `diligent-context`, consuming active checkpoints as carry-forward input
- **diligent-contemplate** — generate semantic contemplation checkpoints without relying on Pi-core assistant-message persistence

## Install

These extensions are intentionally kept lightweight. There is no package wrapper yet.

Copy the extension folders you want into either:

- `~/.pi/agent/extensions/` for user-level use, or
- `<your-project>/.pi/extensions/` for project-local use

Example:

```bash
cp -R extensions/diligent-context ~/.pi/agent/extensions/
cp -R extensions/diligent-compact ~/.pi/agent/extensions/
cp -R extensions/diligent-contemplate ~/.pi/agent/extensions/
```

## Important

Dependency notes:

- `diligent-compact` depends on shared helpers from `diligent-context/core.ts`
- `diligent-contemplate` depends on both `diligent-context` and `diligent-compact/shared.ts`

So for now:

- install `diligent-context` + `diligent-compact` together
- install all three folders together if you want `diligent-contemplate`

## Commands

### diligent-context

- `/diligent-context`
- `/diligent-context here`
- `/diligent-context pick`
- `/diligent-context off`

### diligent-compact

- `/compact`
- `/diligent-compact [instructions]`
- `/diligent-compact --force-native [instructions]`

### diligent-contemplate

- `/diligent-contemplate [custom prompt]`

## Architecture

- `diligent-context` owns the pruning boundary, persisted checkpoints, restoration, and checkpoint projection rules
- `diligent-compact` performs visibility-aware compaction over the same live visible universe the model sees
- `diligent-contemplate` produces semantic contemplation checkpoints that `diligent-context` persists and projects
- no extension depends on a Pi-core assistant-message persistence API

## Local workflow

Committed local changes from `diligent-pi` are copied into your user-level Pi extensions install by your local process.

Recommended local workflow:

1. work in this repo
2. commit in `diligent-pi`
3. test from the user-level Pi extensions install before pushing upstream

This intentionally propagates **committed local changes only**.
Uncommitted work stays local until you make it a real checkpoint via commit.

## Notes

These extensions are stable enough to use, but the structure may still evolve as the architecture is refined.