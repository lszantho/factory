# ADR 007: `bypassPermissions` for background dispatches

## Status

Approved

> **Update 2026-07-21.** The `--disallowedTools` denylist this ADR describes as half the safety net was, for a period, documented but **not actually passed** by `dispatch()`. It is now implemented (config-driven, `configs/<repo>.json` → `disallowedTools`), but note the honest limits — prefix-glob patterns, and deny-vs-`bypassPermissions` precedence assumed rather than confirmed. See [../EXECUTION_AND_PERMISSIONS.md](../EXECUTION_AND_PERMISSIONS.md) §3 for the current state and the PreToolUse-hook upgrade path if airtight enforcement is needed.

## Context

A factory-dispatched agent is a `claude --bg` session with no terminal attached: nobody is there to answer an interactive permission prompt. For the session to do real work — run `git`, `dab`, `gh`, `pnpm`, edit files — it must be able to proceed without prompting.

Claude Code's `acceptEdits` permission mode is not sufficient here. It auto-accepts file edits but **still prompts for Bash commands** (`git`/`dab`/`gh`/`pnpm` are all Bash). In a `--bg` session with no TTY, that prompt can never be answered, so the session hangs permanently in a "blocked" state — which is exactly the failure that must be avoided for unattended operation.

This raises the obvious safety question: if the dispatched session can run anything without prompting, what stops it from doing something destructive?

## Decision

**Dispatch with `--permission-mode bypassPermissions`, and make the safety net declarative rather than interactive.**

- The orchestrator dispatches roles with `--agent <role> --permission-mode bypassPermissions --bg`. (It also passes the prompt as a plain positional argument, because `--bg` is incompatible with `--print`/`--output-format`.)
- Safety does **not** come from an interactive approval step — there is none by design. It comes from two declarative constraints:
  - **The target repo's `AGENTS.md` §6 ("Autonomous Factory Mode")** defines what a factory-dispatched session may and may not do, standing in for the interactive-pairing rules that govern normal sessions.
  - **`--disallowedTools`** removes destructive capabilities at the tool level, so the prohibition is enforced by the harness, not merely instructed.

The reasoning is recorded inline in `dispatch()`: `acceptEdits` would leave a `--bg` session permanently blocked on Bash prompts it cannot answer, so the declarative restrictions are the actual safety net, not an interactive gate.

## Consequences

- **Dispatched sessions can complete real work unattended** without deadlocking on prompts.
- **Safety is only as good as `AGENTS.md` §6 and the `--disallowedTools` list.** These become security-relevant configuration: a gap there is a gap in the guardrail, since there is no interactive backstop. They deserve the same care as the code.
- **Blast radius is further contained by other decisions**, not this one alone: work happens on a per-task worktree/branch, never directly on `main`; the merge to `main` is human-gated ([ADR 006](ADR_006_HUMAN_MERGE_GATE_AND_BUDGET.md)); and the reviewer role plus CI stand between any dispatched output and a merge.
- **This is scoped to factory dispatches only.** `bypassPermissions` is used because these are non-interactive, restriction-bounded sessions recognisable by `FACTORY_DISPATCH=1`; it is not a statement about interactive use, where the normal permission prompts remain appropriate.
