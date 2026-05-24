# Contributing

`diligent-pi` is the source of truth for the diligent Pi extensions. Keep changes here first, then copy or vendor downstream only after the public repo is updated.

## Local setup

This repo intentionally stays lightweight:

- no package wrapper;
- no publish metadata;
- no installer or sync script;
- no CI workflow in this pass.

Use Bun for the local test suite.

```bash
bun run validate:local
```

`validate:local` currently runs:

```bash
bun test tests
```

## What to read before changing behavior

- `README.md`
- `extensions/diligent-context/README.md`
- `extensions/diligent-context/spec.md`
- `extensions/diligent-compact/README.md`
- `extensions/diligent-contemplate/README.md`
- `docs/plans/diligent-pi-polish-2026-05-24.md` for the current readiness plan

## Testing conventions

- Prefer tests around pure seams before changing runtime orchestration.
- Existing tests use `bun:test`.
- Mock Pi APIs directly in tests instead of requiring a real Pi runtime.
- For compaction/model tests, cover both API-key and request-header auth because current Pi model registry auth can return either.
- Keep compatibility tests sensitive to Pi native `compact(...)` argument ordering: preparation, model, API key, headers, custom instructions, signal, thinking level.
- Runtime smoke against a real Pi install is valuable but does not replace the local Bun tests.

## Architecture guardrails

- `diligent-context` owns persisted diligent state, pruning boundaries, checkpoint projection, and restoration.
- Persisted diligent state is authoritative; runtime snapshots are caches only.
- Synthetic checkpoint projection must never pollute real runtime snapshots.
- `diligent-compact` must stay aligned with the same visible universe the model sees.
- Active checkpoints are carry-forward summary input for compaction, not ordinary hidden history.
- Compaction should fail closed when live/session alignment is unsafe.
- `/diligent-compact --force-native` is the explicit one-shot escape hatch for bypassing visibility guarantees.
- `diligent-contemplate` should write nothing on unsafe inputs or stale live context.
- Do not change the persisted `DiligentContextState` schema without a separate explicit plan.

## Documentation expectations

Update public docs in the same change set when behavior changes:

- root `README.md` for user-facing install/update/config/validation notes;
- extension README files for command-specific behavior;
- `CHANGELOG.md` for user-visible readiness changes and validation notes.

Do not document behavior that only exists in a downstream vendored copy.

## Distribution and release guardrails

This repo currently uses manual copy-based distribution. Do not add any of the following without a separate plan:

- installer scripts;
- package wrappers;
- package publishing metadata;
- generated release automation;
- CI workflows;
- downstream-project-specific behavior.

Local model choices belong in installed `extensions/diligent-compact/config.local.json`, not in committed `config.json` unless the shared defaults are intentionally changing.

## Smoke checklist

When a real user-level Pi install is available, copy the three extension folders into `~/.pi/agent/extensions/` and smoke:

1. `/diligent-compact` with configured candidates unavailable warns before current-model fallback.
2. `/diligent-compact --force-native` warns that visibility guarantees are bypassed.
3. `/diligent-contemplate` emits a checkpoint artifact and re-anchors after represented real visible payload.
4. A successful compaction after active checkpoints clears them.

If smoke is unavailable, record that explicitly in the changelog or implementation summary.
