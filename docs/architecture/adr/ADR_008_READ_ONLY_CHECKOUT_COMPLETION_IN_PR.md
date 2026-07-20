# ADR 008: The orchestrator only reads and fast-forwards the target checkout; completion flows through the PR

## Status

Approved

## Context

The orchestrator runs `dab` commands against the target repo's local `main` checkout (`config.repoDir`) to observe the board — what work exists, what's done, what epic can close. Two related problems came from how it interacted with that checkout:

1. **The checkout went stale after every merge.** Merges land on `origin` via `gh pr merge`, which is a remote API call that never touches the local working tree. Git does not auto-pull, so after a merge the local `main` checkout stayed behind `origin/main`, and `dab status`/`dab next` reported a *pre-merge* board. This directly produced a spurious decision: after an epic-close PR merged on origin but the local checkout hadn't been pulled, `dab` still showed the epic as active with zero open tasks, so a tick wanted to dispatch an architect to **re-close an already-closed epic**. (Caught by the `--status` monitor before it fired — see [ADR 002](ADR_002_RECONCILE_STATE_FROM_REALITY.md) for the reconcile-from-reality principle it violated.)

2. **The orchestrator *wrote* to that checkout, outside the PR flow.** On merge (and reconcile), the orchestrator ran `dab complete` against the local checkout to mark the task done — checking the `WORK_PLAN.md` box and setting the spec's `status: done`, or archiving a standalone task. Those edits were never committed or pushed, so the checkout was left **dirty** and the completion never reached `origin` (a fresh agent worktree, checked out from origin, would never see it). It also bypassed the system's core discipline that *every change to `main` goes through a reviewed PR*.

These are two faces of one thing: the orchestrator both **read from** and **wrote to** the same local checkout, and the write is exactly what corrupted the read (a dirty tree can't be fast-forwarded, and un-pushed completion state is invisible to everything downstream).

Notably, epic-close never had either problem, because the architect runs `dab epic close` **inside its worktree**, so the archive move is part of the reviewed PR and lands on `main` atomically with the merge. Task completion was the only holdout still mutated post-merge by the orchestrator.

## Decision

**Establish one invariant: the orchestrator only ever *reads* and *fast-forwards* the target checkout — it never writes to it. All changes to the board go through agent worktrees and reviewed PRs.** Two changes enforce it:

1. **Completion flows through the PR.** The **developer** runs `dab complete <taskId>` in its own worktree as part of implementing the task, and commits that bookkeeping (checked box + `status: done`, or the archive move) into the PR — so the reviewer reviews the completion claim and it lands on `main` atomically with the code. The orchestrator's post-merge `dab complete` calls (in both the `merge` and `reconcile-merged` paths) are removed. This makes task completion work exactly like epic-close already does.

2. **Sync before observing.** At the start of every tick *and* every `--status`, the orchestrator runs `git -C <repoDir> pull --ff-only`. If it can't fast-forward, the tick stops with `blocked: repo-sync-failed` rather than deciding against a stale board.

Because of (1), the checkout is never written to locally, so it can only ever be *behind* origin, never *divergent* — which is exactly the condition under which `--ff-only` always succeeds. (1) is what makes (2) reliable.

### Rejected alternative

Have the orchestrator commit its `dab complete` change to `main` and push it. This keeps completion orchestrator-owned but reintroduces the very thing the design avoids: a **direct-to-`main` commit that skips review**, plus a noisy second commit after every squash merge, and it *still* requires the checkout to be clean and synced first. Moving completion into the PR is strictly better.

## Consequences

- **The dirty-checkout problem is gone by construction, not worked around.** Nothing local ever diverges, so the fast-forward is always clean. The invariant is simple to state and easy to keep: the orchestrator reads and fast-forwards; it never writes.
- **Completion is now reviewed.** The reviewer verifies "this PR claims to complete task X — does the diff deliver X?" instead of completion being an invisible post-merge side effect.
- **"Done" is marked at PR-open, not at merge.** Acceptable and arguably better: it's the reviewable "Closes #X" semantics; if the PR is closed without merging, the mark dies on the branch and never reaches `main`. During the in-flight window the orchestrator drives the task by **PR state** (from `state.json` + GitHub), not by the dab flag, so a box checked on the branch but not yet on `main` doesn't mislead it.
- **A failed sync is a blocking condition.** Better to stop and surface it than to dispatch or merge against a stale board. Given the invariant, a failed `--ff-only` now signals a genuine anomaly (someone wrote to the checkout, or a real divergence), not routine drift.
- **A new dependency on the developer persona.** If a developer forgets to run `dab complete`, the task's box stays unchecked on `main` after merge, and `dab next`/`findClosableEpic` keep treating it as open — visibly (the `--status` monitor would show the epic not advancing), and correctable, but it is now the persona's responsibility rather than the orchestrator's guarantee.
- **Latent, pre-existing and unchanged by this ADR:** `decide()` can, in a narrow window (a tracked in-flight task whose `inFlightAction` returns `wait`, with no running session), fall through to `dab next` and re-return that same still-"active"-on-`main` task. This window is identical before and after this change (main reflects "done" only at merge either way). Worth hardening separately — e.g. the developer `dab claim`-ing the task, or `decide()` skipping `dab next` items already tracked in `state.json`.
