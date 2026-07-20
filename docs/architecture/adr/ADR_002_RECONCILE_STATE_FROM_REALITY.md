# ADR 002: Reconcile state from reality; don't store process state

## Status

Approved

## Context

The factory drives a piece of work through a lifecycle: dispatched → PR opened → CI → review → approved → merged → (task marked done, epic eventually closed). The natural way to build this is an explicit state machine with a stored current phase per task — an event-driven model where "a PR was opened" transitions the task from `implementing` to `in-review`, and so on.

That approach has a structural weakness. Its correctness depends on a stored model of "where each task is" staying faithful to reality — which in turn depends on never missing an event, never misordering one, and never having anything change the world through a channel the model doesn't observe. In this system, that last condition is impossible to guarantee: a PR can be merged or closed by a human clicking in GitHub's web UI, by `gh pr merge` run directly in a terminal, or by auto-merge — none of which the orchestrator emitted or witnessed. The moment reality changes behind the model's back, the model is wrong and stays wrong until someone notices.

We also observed, correctly, that the "process" concept in this system has no solid foundation in code — it is implicit, coming alive only when the orchestrator is triggered. The question was whether to *give* it a foundation by making it explicit and stored, or to lean into the implicitness.

## Decision

**The orchestrator is level-triggered, not edge-triggered. It stores no lifecycle state and re-derives the next action, in full, from observed reality on every tick.**

Each tick computes a nearly pure function:

```
next_action = f( dab board, GitHub PR state, live agent sessions )
```

It does not react to *changes*; it reacts to *current state*. "There is an open PR with green CI and no review" is sufficient, by itself, to decide "dispatch a reviewer" — no memory of how we got there is consulted. This is the reconciliation-loop pattern (as used by Kubernetes controllers): don't track what you did, look at what *is*, and act to close the gap.

The one exception is `state.json`, which persists only the **irreducible** fact that genuinely cannot be observed from dab or GitHub: which branch and role the orchestrator associated with a task at dispatch time. Even this is treated as a hint, not an authority — everything derivable from reality (does a PR exist, its CI/review/merge status, whether the task is done) is re-derived every tick, never cached and trusted.

Concretely, `findPrForBranch` queries GitHub for PRs in **all** states (`--state all`) and the decision logic branches on the actual `state` GitHub reports — `MERGED` reconciles the task to done, `CLOSED`-without-merge is surfaced for a human, `OPEN` continues the lifecycle.

## Consequences

- **Crash-safe.** The orchestrator holds no authoritative state, so it can die at any point and lose nothing; the next tick rebuilds the picture.
- **Idempotent.** A tick with nothing changed yields `wait`/`idle`, never a duplicate action.
- **Self-healing across any channel.** A PR merged or closed by *any* means is reconciled on the next tick, because the tick asks reality directly rather than trusting what it remembered doing.
- **Every tick pays an observation cost.** The design trades a few `dab`/`gh` calls per tick for not having to keep a model in sync. Given the tick cadence, this is cheap and worth it.
- **Observation must be *complete*.** The failure mode of this design is not stale memory — it's *partial* observation. The bug below came from asking reality an incomplete question.

### Evidence: the out-of-band merge (the bug that proved the rule)

Early on, the orchestrator kept remembered state (`state.json` said "task X in flight on branch Y") and queried only **open** PRs. A PR was then merged by a human via `gh pr merge`, directly, bypassing the orchestrator. On the next tick, the open-only query returned nothing — read as "no PR exists yet, work unfinished" — and once past the staleness window, the orchestrator **dispatched an agent to redo already-merged work.**

The fix was not to record the merge more diligently in `state.json`. It was to **observe reality more completely**: query all PR states and branch on the real `MERGED`/`CLOSED`/`OPEN` fact. The defect lived in the single place the system leaned on memory plus a narrow query instead of a complete observation; the cure was to lean harder on observation. This is the load-bearing example behind the whole principle — see [../PRINCIPLES.md](../PRINCIPLES.md) §2.

### Related, same root

Two other bugs found in the same period were the same shape — trusting a stored/reported value over a complete observation of reality:

- Session liveness was gated on `claude agents --json`'s reported `pid`, which lies in both directions; replaced with the session transcript's mtime (observe the actual output). See [ADR 005](ADR_005_LIVENESS_FROM_TRANSCRIPT_MTIME.md).
- After a dispatch, the new session's id was resolved by taking the *first* name match in a list that never prunes finished sessions; fixed by taking the most recently started — i.e. reading the list as the noisy reality it is, not as if each name were unique.
