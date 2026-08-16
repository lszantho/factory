---
id: let_agents_mark_a_task_blocked_operator
title: Let agents mark a task blocked-operator
author: Lucian Szantho
date: 2026-08-16
status: backlog
subsystem: agents
type: feature
---
# TODO: Let agents mark a task `blocked-operator` instead of guessing

**Migrated from the `LeanMacroFeed` board, 2026-08-16.** It was §4 of that repo's *CI Budget & the Deployment Trigger* RFC, which named it *"the higher-value work of the two"* and then correctly declined to do it, because it is a change to the agent role prompts and `orchestrator.mjs` — a different repository, which until today had no board to move it to.

## The gap

`.claude/agents/developer.md` (in the consuming repo) tells a developer agent:

> If the task spec is ambiguous or contradicts the codebase as it actually exists, **say so in the PR description** rather than guessing silently — the reviewer or architect will pick it up.

So the agent still guesses. It just annotates the guess. **There is no path where an agent stops, records why, and opens nothing.** The only outcomes available to a dispatched developer are "a PR" or "an unexplained absence of a PR", and the orchestrator cannot distinguish the second from a crash, a hang, or a session that is still thinking.

## Why the mechanism already exists

The `blocked-operator` status added on 2026-08-15 does exactly the right thing — for blockers *someone anticipated at authoring time*:

- `dab next` refuses to hand out the task
- it lands in `dab status`'s `blockedTasks` bucket
- `findOperatorBlockedTask` ([orchestrator.mjs](../../orchestrator.mjs)) picks it up and notifies under *"Factory: your turn"* with the `blocked_reason` as the body
- `findClosableSprint` counts it as open, so no architect is dispatched to close a sprint whose last item is still owed

That path was exercised end to end on 2026-08-12 and behaved exactly as designed. **The whole machine is built; only the agent cannot reach it.**

## Proposed change

A dispatched agent that concludes the task cannot be done as specified should be able to write `status: blocked-operator` plus a `blocked_reason` into the task spec, commit that alone, and open no PR — or open a PR containing only the spec change, if a review of the *reasoning* is wanted.

Design questions this task must answer rather than assume:

- **Which roles may do it.** A developer, certainly. A reviewer? An architect deciding a sprint cannot close?
- **How to prevent it becoming an escape hatch.** An agent that finds any task hard could mark it blocked and exit. The `blocked_reason` is the natural guard — it must name *what the operator must do*, not *why the agent stopped* — but that is a prompt-quality constraint, not an enforceable one. Worth considering a rejection count, as with `changes-requested`.
- **Whether the orchestrator should distinguish agent-set from author-set blocks.** They mean different things: one is "this was always human work", the other is "the spec is wrong". The second may deserve escalation to the architect rather than to the operator.
- **What happens to the worktree and branch.** Probably deleted, since there is no PR — but that interacts with the branch-inheritance defect in RFC 006 §2.2.

## Evidence that this is worth building

Two occasions where an agent *did* stop correctly, and the only reason the stop worked is that the agent chose to read and obey a sentence in its spec:

- **2026-08-12**, four separate dispatches onto `rebuild_the_ledger_on_corrected_periods`, a production wipe-and-rebuild. Each agent read *"This is an operator session, not a factory task"*, refused, and exited having run only read-only commands. Nothing structural stopped it; conscientiousness did, four times.
- **2026-08-15**, `speed_up_the_e2e_job`, whose spec demanded a measurement across six CI runs. Here the agent did **not** stop — it drove CI in a `gh run rerun` loop for four hours until a human intervened. Same class of impossible instruction, opposite outcome.

The difference between those two is luck. A structural stop is what removes it.

## Requirements

- [ ] A dispatched agent has a defined, prompted path to stop and record a blocker without opening a PR.
- [ ] The `blocked_reason` it writes names the operator action required, in the imperative, not the agent's difficulty.
- [ ] The orchestrator surfaces an agent-set block the same way it surfaces an author-set one, and does **not** re-dispatch the task.
- [ ] Something bounds abuse — a repeat count, an architect escalation, or a rule that a second block on the same task escalates rather than repeats.
- [ ] The role prompts in the consuming repos are updated in the same change; a capability the prompt does not mention does not exist.

## Tasks

- [ ] Decide the four design questions above.
- [ ] Add the stop path to the `developer` role prompt (and any other role that gets it).
- [ ] Teach `orchestrator.mjs` to expect a no-PR outcome that is a *result* rather than a failure.
- [ ] Decide worktree/branch cleanup, in coordination with RFC 006 §2.2 and §3.3.

## Verification Plan

### Automated Tests

- Given a task spec that contradicts the codebase, a dispatched developer produces a `blocked-operator` spec change and no PR. **Fails today** — it opens a PR containing a guess plus a note.
- `decide()` returns `blocked` (not `wait`, and not a re-dispatch) for a task an agent has marked blocked.

### Manual Verification

1. Confirm the *"Factory: your turn"* notification carries the agent-written `blocked_reason` legibly.
2. Confirm the sprint does not close while the block stands.

---

## Notes

Related: [RFC 006](rfcs/rfc_006_complete_observation_gaps.md) §2.3 — nothing currently distinguishes retrying from retrying something impossible. This task attacks the same problem from the agent's side: the orchestrator learning to give up is one half, an agent able to say *"this cannot be done"* is the other.
