# RFC 006: The three places the orchestrator still trusts memory over reality

## Status

**Proposed — not started.** Written 2026-08-16 from a single evening's incidents on the `leanmacrofeed` repo, in which three separate failures cost roughly six hours of operator attention and burned CI minutes on work that could never succeed. None of them is a new design problem. All three are **the same defect [ADR 002](../../../docs/architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md) already names** — *"the failure mode of this design is not stale memory, it's partial observation"* — surviving in three places the ADR's original fix did not reach.

This RFC proposes no new architecture. It proposes finishing an approved one.

## Context & Motivation

ADR 002 decided that the orchestrator is level-triggered: it stores no lifecycle state and re-derives its next action from observed reality every tick. `state.json` persists only the irreducible dispatch-time association of task → branch → role, and — the ADR is explicit — *"even this is treated as a hint, not an authority."*

`findPrForBranch` honours that faithfully: `--state all`, branch on the real `MERGED`/`CLOSED`/`OPEN` fact, take the highest PR number because branch names get reused. That function is the ADR working.

Three other places do not honour it. Each treats a remembered value as authoritative, or asks reality a question narrow enough to get a confidently wrong answer.

### 2.1 The WIP check reads `state.json` as the authority on what is in flight

[orchestrator.mjs](../../../orchestrator.mjs), in `decide()`:

```js
const inFlightIds = Object.keys(state.tasks).filter((id) => state.tasks[id].branch);
const wipLimit = config.maxConcurrentTasks ?? 1;
if (inFlightIds.length >= wipLimit) {
  if (firstInFlightWait) return firstInFlightWait;
  return { action: 'wait', reason: 'wip-limit-reached', ... };
}
```

`Object.keys(state.tasks)` is memory. Nothing asks whether those tasks still exist on the board.

**What happened.** A task (`rebuild_the_ledger_on_corrected_periods`) was dispatched, declined by the agent as human-only work, and later moved out of its sprint back to the repo's backlog. Its `state.json` entry — complete with a `branch` — survived. From then on `inFlightIds.length` was `1`, `wipLimit` was `1`, and **the orchestrator returned before ever calling `dab next`.** It could not see the active sprint at all. It re-dispatched the phantom task instead, four times over two sessions; each agent read the spec, correctly refused, opened no PR, and therefore never freed the slot.

The operator-facing symptom was *"why is the factory so slow?"* — which points nowhere near a stale map key.

This is precisely ADR 002's load-bearing bug wearing different clothes. There, `state.json` said "in flight on branch Y" and a narrow query (`--state open`) failed to contradict it, so an agent was dispatched to redo merged work. Here, `state.json` says "in flight" and **no query is made at all**.

### 2.2 An abandoned remote branch is inherited by the next dispatch

When a PR is closed unmerged and its branch is deleted locally but not on the origin, the next dispatch for that task recreates the branch **from the surviving remote**, silently inheriting the abandoned history.

**What happened.** PR #322 was closed unmerged. Its local branch and worktree were removed; `origin/worktree-speed_up_the_e2e_job` was not. The next dispatch branched from that remote, so the new branch carried #322's commits plus a duplicate of an already-merged PR under a different SHA, and its merge-base was three merges behind `main`. The resulting PR (#324) was `CONFLICTING`, so **GitHub never built a merge ref and never created a `pull_request` workflow run**.

The orchestrator saw `ci: "no-ci"` and reported `wait — ci-not-reporting`. That is a permanent condition presented as a transient one, and it sat there indefinitely.

The observation gap: the orchestrator observes *"is there a PR, and what is its CI state"*, and never observes *"is this branch actually based on the branch it targets"* — a question `gh pr view --json mergeable,mergeStateStatus` answers directly.

### 2.3 Nothing distinguishes "retrying" from "retrying something impossible"

Three incidents in one evening, one shape:

| Incident | Ticks / attempts wasted | Why it could never succeed |
| :--- | ---: | :--- |
| GitHub Actions spending limit reached | 12 ticks, logged as `ci-red-after-fix` | Jobs were never *started*; the run failed in 1–3s with a billing annotation and no steps. Indistinguishable from red CI through `statusCheckRollup`. |
| Phantom in-flight task (§2.1) | 4 dispatches | No agent would ever do the work; no PR could ever appear. |
| Agent-side `gh run rerun` loop | 4 CI runs, incl. one 57-min failure and one 3h14m hang | The task spec demanded a measurement requiring six CI runs — unachievable inside one session. |

`state.quietRepeatCount` already counts consecutive identical decisions. Nothing consumes it. A tick that reaches the same conclusion for the twentieth time is not patient; it is stuck, and only a human can tell the difference — which is the definition of something that should be escalated rather than repeated.

Note also that `ci-not-reporting` is a **`wait`**, not a `blocked`. It never notifies. §2.2's dead PR would still be sitting there.

## Proposed Architecture & Design

Four, in descending value. Each is small and independently shippable.

### 3.1 Reconcile in-flight state against the board

Before the WIP check, drop any `state.tasks` entry whose id does not appear in `dab status`'s three buckets (or as a `sprint-close-*` pseudo-task). Memory becomes a hint again, as ADR 002 requires.

This single change eliminates §2.1 outright and is roughly ten lines.

### 3.2 Observe mergeability, not just PR existence

Extend `findPrForBranch`'s query with `mergeable,mergeStateStatus`. A `CONFLICTING` PR becomes a `blocked` decision naming the conflict, rather than an indefinite `wait — ci-not-reporting`.

Optionally: on dispatch, refuse a branch whose merge-base is not the base branch's tip. That closes §2.2 at the cause rather than the symptom, but is the more invasive of the two.

### 3.3 Delete the remote branch when abandoning a PR

Whatever closes a PR without merging should delete the remote head branch, or the orchestrator should treat a branch with a closed-unmerged PR as unusable and dispatch to a fresh name. Today the cleanup is manual and its omission is invisible until it produces an unbuildable PR.

### 3.4 Consume `quietRepeatCount`

Above a threshold, convert a repeated `wait`/`blocked` into an operator notification. The threshold matters less than the existence of a ceiling: **no condition should be retried indefinitely without a human being told.**

## Alternatives considered

- **Store more state, more diligently** — e.g. mark the phantom task "abandoned" in `state.json`. Rejected for the same reason ADR 002 rejected it originally: the cure for a wrong memory is not a better memory, it is a complete observation. This RFC exists because that principle was applied in one place and not three others.
- **Raise `maxConcurrentTasks`** so a single stuck entry cannot block everything. Rejected — it converts a hard stop into a slow leak, and the WIP limit is doing its job correctly; the input is wrong.
- **Have agents mark tasks `blocked-operator` themselves.** Genuinely valuable and already noted as *"the higher-value work of the two"* in the consuming repo's CI RFC — but it is a change to agent prompts and the dispatch contract, and orthogonal to these four. Deliberately out of scope.
- **Do nothing; these are rare.** They were not rare. Three occurred in one evening, and each presented as something other than its cause: "slow", "no checks attached", "red CI".

## Risks & open questions

- [ ] **§3.1 needs care about legitimately-in-flight-but-not-on-the-board tasks.** `sprint-close-*` pseudo-tasks have no board entry by construction. The reconciliation must whitelist them or key off a different discriminator.
- [ ] **§3.4's threshold is a judgement call**, and too low a value makes the factory noisy — which trains the operator to ignore it, the exact failure the notification is meant to prevent.
- [ ] **§3.2 may reclassify transient states as blocked.** A PR can be briefly `UNKNOWN`/`DIRTY` while GitHub computes mergeability; the check should require the condition to persist across ticks before escalating.
- [ ] **None of this addresses the billing wall directly.** Distinguishing "the runner never started" from "the tests failed" needs the run's annotations, not `statusCheckRollup`. Worth a separate look — it is the one incident of the three that a human also could not diagnose from the factory's own output.
- [ ] **This repo has no board of its own**, so findings about the factory are recorded in whichever consuming repo happened to surface them. That is why an evening's worth of orchestrator defects ended up documented in a macroeconomics project's sprint archive.
