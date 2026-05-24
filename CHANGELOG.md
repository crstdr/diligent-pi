# Changelog

All notable user-facing changes to `diligent-pi` should be recorded here.

## Unreleased

### Added

- Added a private local validation entrypoint: `bun run validate:local`.
- Added layered model configuration for the shared opinionated stack used by `/diligent-compact` and `/diligent-contemplate`.
- Added `extensions/diligent-compact/config.local.example.json` to document ignored installed overrides.
- Added direct tests for compaction visibility/preparation seams, diligent-context checkpoint/projection invariants, and diligent-contemplate command safety paths.
- Added contributor documentation and expanded user-facing install/update/config/troubleshooting docs.
- Added an investigation report for `/diligent-context` boundary safety against active model context-window limits.

### Changed

- Refreshed shipped model candidates to Anthropic Opus 4.7, OpenAI Codex GPT-5.5, OpenAI Codex GPT-5.4, and Anthropic Sonnet 4.6, while preserving current-session model fallback.
- Compatibility compaction now preserves current Pi model-registry auth headers and thinking level when calling Pi native `compact(...)`.
- Compaction visibility/preparation helpers were extracted behind tested pure seams without changing the fail-closed route posture.
- Documentation now makes copy-based distribution, local-only validation, and the no-package-wrapper posture explicit.

### Notes

- This readiness pass does not change the persisted diligent state schema.
- Distribution remains manual copy into `~/.pi/agent/extensions/` or `<project>/.pi/extensions/`.
- No installer scripts, package wrappers, CI workflows, package publishing metadata, or release automation were added.

### Validation

- 2026-05-24: `bun run validate:local` passed from the repo root (`75 pass`, `0 fail`).
- Real user-level Pi smoke: unavailable/not run in this final validation pass; no interactive Pi user-level smoke result is being claimed.
