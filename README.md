# diligent-pi

A small collection of Pi extensions focused on **careful context shaping** rather than maximal automation.

This repo is the **canonical source of truth** for the diligent extensions.
Downstream consumers should vendor from here rather than evolving their own divergent copies.

Current extensions:

- **diligent-context** — hide stale tool chatter from the live payload while preserving the human conversation
- **diligent-compact** — keep compaction aligned with the context that remains visible under `diligent-context`, with diagnostics and an explicit `/diligent-compact` command

## Install

These extensions are intentionally kept lightweight. There is no package wrapper yet.

Copy the extension folders you want into either:

- `~/.pi/agent/extensions/` for user-level use, or
- `<your-project>/.pi/extensions/` for project-local use

Example:

```bash
cp -R extensions/diligent-context ~/.pi/agent/extensions/
cp -R extensions/diligent-compact ~/.pi/agent/extensions/
```

## Important

`diligent-compact` depends on the shared `diligent-context/core.ts` helpers, so for now you should install **both folders together**.

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

## Downstream workflow

Downstream consumers can sync from the local committed `diligent-pi` `HEAD`.

Recommended local workflow:

1. work in this repo
2. commit in `diligent-pi`
3. sync the committed state into your downstream consumer or extension install
4. test before pushing upstream

This intentionally syncs **committed local changes only**.
Uncommitted work is excluded so downstream testing stays reproducible.

## Notes

This is a personal repo shared for practical use. The extensions are stable enough to use, but the structure may still evolve.
