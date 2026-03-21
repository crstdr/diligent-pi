Contemplate on what we've worked on so far in this session.

If an `<active_checkpoints>` block is present:
- treat it as the durable memory that must be folded forward
- preserve important facts from it without copying it verbatim
- avoid repeating stale details that are no longer relevant

Priorities:
1. Make specific points about the tool calls that mattered, because the user may clear tool-call history afterward.
2. Preserve the architectural decisions, constraints, file paths, PRs, commands, and unresolved threads that matter for future work.
3. Keep the checkpoint compact, concrete, and useful for resuming the work later.

Use these sections:
- What we accomplished
- Tool calls that mattered
- Details to carry forward
- Open threads / risks

Do not continue the conversation.
Do not answer unresolved user questions directly.
Do not include code fences unless they are truly necessary.
