# Design principles

This document explains *why* the factory is shaped the way it is. The specific decisions are recorded as [ADRs](adr/README.md); this is the philosophy those decisions share.

## 1. The "process" is deliberately implicit

There is an intuitive concept at the heart of the factory: a **process** — a single piece of work being started and driven to completion, from backlog item to merged PR through design, implementation, and review.

That concept has **no first-class representation anywhere in the code.** There is no `Process` object, no stored `phase: "awaiting-review"` field, no thread of execution that owns a task from birth to death. Search the code for it and you won't find it.

Instead, the process is **emergent**. It comes alive for a few milliseconds every time the orchestrator is triggered, is reconstructed from scratch by observing the world, produces exactly one action, and vanishes again. Between ticks, the "process" does not exist anywhere except as facts scattered across external systems. What looks like one continuous piece of work being shepherded forward is really a series of independent, stateless observations that each happen to reach a consistent conclusion about "what's the next thing to do."

This is not an accident or an omission. It is the central design choice, and everything else follows from it.

## 2. Derive state from reality; do not store it

The single most important principle: **the more the system derives its state from reality rather than remembering it, the more resilient it is.**

Every tick, the orchestrator answers one question — *given the world exactly as it is right now, what is the single next action?* — as a nearly pure function of observed reality:

```
next_action = f( dab board, GitHub PR state, live agent sessions )
```

It does **not** maintain a model of "where each task is in its lifecycle" and advance that model on events. It re-derives the answer, in full, from the ground truth, every single time.

This is the distinction between two control patterns:

- **Edge-triggered** (event-driven): react to *changes* — "a PR was opened, so move this task to the review phase." Requires a durable, correct model of current state, and correctness depends on never missing or misordering an event. When the model and reality disagree, the system is wrong until someone notices.
- **Level-triggered** (reconciliation): react to *current state* — "there is an open PR with green CI and no review, therefore dispatch a reviewer." No stored phase to drift. If the model is lost, corrupted, or never existed, the next observation rebuilds the correct answer from reality.

The factory is level-triggered. It is the same pattern a Kubernetes controller uses: don't track what you did, look at what *is*, and reconcile toward the goal. The reason it *feels* like it lacks a foundation is precisely that its state machine is implicit in the branching logic rather than materialised as data — but that implicitness is the source of its robustness, not a gap in it.

### Why this is resilient

- **Crash-safe.** The orchestrator can die at any instant — mid-tick, between ticks, for a week — and lose nothing, because it was never holding the authoritative state. The next tick reconstructs it.
- **Idempotent.** Running a tick when nothing changed produces `wait`/`idle`, not a duplicate action. Running it twice is the same as running it once.
- **Self-healing.** Any drift between what the orchestrator "thought" and what actually happened is corrected on the next observation, automatically, regardless of *how* the drift arose.

### The evidence: the out-of-band merge

This principle was proven by violating it. The orchestrator kept one piece of remembered state — `state.json`'s record that "task X is in flight on branch Y" — and one query that trusted a narrow slice of reality: it asked GitHub only for **open** PRs.

When a PR was merged *outside* the orchestrator (a human running `gh pr merge` directly), reality moved on but the two didn't agree: `state.json` still said "in flight," and the open-PRs-only query returned nothing — which the orchestrator misread as "no PR exists yet, the work isn't done." Past the staleness window, it dispatched an agent to *redo already-merged work.*

The fix was not to track the merge more carefully in `state.json`. It was the opposite: **query reality more completely.** Ask GitHub for PRs in *all* states, and branch on the actual `MERGED` / `CLOSED` / `OPEN` fact it reports. The bug existed in exactly the one place the system leaned on memory instead of observation; the cure was to lean harder on observation. (See [ADR 002](adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md).)

The lesson generalises: **when the factory misbehaves, the culprit is almost always a place where it trusted stored state over observed reality, or observed reality incompletely.** The fix is rarely "remember more" and usually "observe more, and more completely."

### The one unavoidable piece of memory

`state.json` is not zero. It holds the minimal fact that *cannot* be re-derived from dab or GitHub: **which branch and role the orchestrator associated with a task when it dispatched work.** GitHub doesn't know "the factory started a developer on this at 09:00"; dab doesn't either. This thread is the irreducible minimum.

The discipline is to keep it *minimal* and to treat it as a hint, not an authority. Everything that *can* be re-derived from reality (is there a PR, did CI pass, was it approved, was it merged, is the task done) *is* re-derived, every tick — never cached in `state.json` and trusted.

The same discipline applies to the target repo's local checkout that the orchestrator reads `dab` from. It's a *mirror* of `origin`, not a source of truth — so a tick fast-forwards it to `origin` before observing, and the orchestrator never writes to it (task completion flows through the reviewed PR instead of a post-merge local mutation). That keeps the mirror strictly a reflection of merged reality, never a private draft that can drift. See [ADR 008](adr/ADR_008_READ_ONLY_CHECKOUT_COMPLETION_IN_PR.md).

## 3. A deterministic core; intelligence only at the edges

The orchestrator makes **no LLM call of its own.** It is a plain, deterministic router: read state, run a fixed decision tree, emit one action. Given the same observed reality, it always decides the same thing.

All judgment — writing code, designing an RFC, deciding whether a PR is good enough to merge — lives exclusively in the **agent sessions it dispatches**. The boundary is deliberate and sharp: the part that must be predictable, auditable, and cheap to run every few minutes is code; the part that needs reasoning is an AI role with a written persona and explicit boundaries. This keeps the coordination layer trivial to understand and trust, and confines non-determinism to units of work that are individually reviewed (by the reviewer role, by CI, and — for now — by a human at the merge gate). See [ADR 001](adr/ADR_001_DETERMINISTIC_ORCHESTRATOR.md).

## 4. Humans gate what is expensive to reverse

Autonomy is introduced deliberately, not maximally — and *relaxed* as trust is earned, gate by gate, rather than granted all at once. The merge to `main`, the one genuinely irreversible step, was a human gate through the first epic; once that epic completed cleanly end-to-end it was retired (`autoMerge: true`, as of 2026-07-20), and the orchestrator now closes the loop itself. Two gates still stand: a rolling dispatch budget caps how much work can be started in any window, so even a misfiring loop cannot run away; and the manual, one-tick-at-a-time cadence keeps a human in the loop at every transition while the pipeline is still young enough to surprise us. The budget is expected to stay indefinitely as a safety limiter; the manual cadence is the next gate to relax (a scheduled trigger). See [ADR 006](adr/ADR_006_HUMAN_MERGE_GATE_AND_BUDGET.md).

## 5. The tool is generic; the behaviour is per-repo

The factory is a mechanism, not a policy. The orchestrator code knows nothing about any particular project. What each role *does*, the conventions it enforces, and the rules a dispatched session runs under all live **in the target repo** (its `.claude/agents/` personas and its `AGENTS.md`), selected by a per-repo config file here. One tool, many repos, no per-repo forks of the engine. This mirrors the split already used by `dab`/`docs-as-board`: the tool stands alone, the content lives with the project. See [ADR 003](adr/ADR_003_STANDALONE_TOOL_PER_REPO_CONFIG.md).
