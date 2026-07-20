# ADR 006: A human merge gate and a dispatch budget while the pipeline matures

## Status

Approved

## Context

The factory is capable of running the full loop unattended: pick up work, implement it, review it, and merge it, on a timer, with no human involved. A `launchd` job to trigger it on a schedule is already written. The question is not *can* it run autonomously, but *how much* autonomy to grant, and when.

The countervailing fact is that the coordination logic is young and has already been observed misfiring in ways that would have been far more damaging on a timer than under manual, one-tick-at-a-time operation — a false "redo already-merged work" dispatch ([ADR 002](ADR_002_RECONCILE_STATE_FROM_REALITY.md)), a reviewer that couldn't record approvals ([ADR 004](ADR_004_DISTINCT_REVIEWER_IDENTITY.md)), unreliable liveness detection ([ADR 005](ADR_005_LIVENESS_FROM_TRANSCRIPT_MTIME.md)). Each of these surfaced once, visibly, at a manual tick where it could be caught — instead of silently, repeatedly, on a schedule.

Merging to `main` is also the one step in the loop that is genuinely expensive to reverse. Everything before it (a branch, a PR, a review) is cheap to discard; a merge is not.

## Decision

**Introduce autonomy deliberately and relaxably, with three gates in place while the pipeline earns trust:**

1. **`autoMerge: false` — a human gates the merge.** The orchestrator drives a task all the way to "approved + green CI" and then stops, reporting `would-merge` rather than merging. A human performs the merge. When the pipeline has proven itself, flipping `autoMerge: true` lets the orchestrator's own `merge` action close the loop (it already exists and does the full `gh pr merge` → `dab complete` → clear-state sequence).

2. **A rolling dispatch budget.** `budget-guard.mjs` caps dispatches to `maxDispatchesPerWindow` within a rolling `windowMinutes` window (default 8 per 300 min). Even a logic error that wants to dispatch endlessly is bounded; when the cap is hit the tick reports `blocked: budget-exceeded` and resumes once the window rolls over.

3. **Manual ticks as the current cadence.** The `launchd` timer is written but deliberately **not loaded**. Running one tick at a time by hand keeps a human in the loop at every transition — itself the strongest circuit-breaker while the state machine is still capable of surprising us.

## Consequences

- **The blast radius of a coordination bug is small.** A misfire shows up at the next manual tick, visible and interruptible, rather than compounding unattended.
- **`ReadyToMerge` never self-resolves today.** With `autoMerge` off, a tick will keep reporting `would-merge` for an approved PR until a human merges it — this is intended, and is the one state that requires human action to advance (see the [state machine](../STATE_MACHINE.md)).
- **Merging outside the orchestrator is possible but must reconcile.** Because a human does the merge, they may do it via `gh` or the GitHub UI — which is exactly why the reconcile-from-reality behaviour of [ADR 002](ADR_002_RECONCILE_STATE_FROM_REALITY.md) is a prerequisite for this gate to be safe: the next tick catches state up regardless of how the merge happened.
- **These gates are milestones, not fixtures.** The intended path is to relax them as confidence grows — load the timer for a self-triggering loop, then enable `autoMerge` for hands-off closing — most likely one at a time, after several clean end-to-end cycles under the current manual operation. The budget cap is the one gate expected to stay indefinitely, as a permanent safety limiter.
