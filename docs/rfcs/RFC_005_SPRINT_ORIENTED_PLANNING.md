# RFC 005: Sprint-oriented planning — one active sprint, immutable scope, findings, and the portfolio view

## Status

**Proposed.** Design settled through a collaborative design session; not yet built. It spans two codebases — `dab` (the `docs-as-board` tool: the board model + invariants) and the factory (`orchestrator.mjs` decision logic + the local UI). It is a *tightening* of how the factory already behaves (single-track, one unit of work at a time, level-triggered), not a rebuild — most of the value is a cleaner model, a `dab` invariant, a findings mechanism, and a new read-only view.

**Vocabulary note:** this RFC replaces the term **epic** entirely with **sprint**. The rename is total — folders, CLI, frontmatter, personas, orchestrator identifiers — see [Rollout](#rollout). "Epic" appears below only where it names the *old* thing being renamed.

## Motivation

Today the board mixes two kinds of work: **epic tasks** (ordered in a `WORK_PLAN.md`) and **loose standalone/backlog tasks**. That split causes friction and at least one known bug — `dab next` never reads `dab/todos/`, so a standalone task is invisible unless it's graduated into an epic or filed in backlog (see [[factory-operational-gotchas]] history and the note near [ADR 008](../architecture/adr/ADR_008_READ_ONLY_CHECKOUT_COMPLETION_IN_PR.md)). It also makes "what is the factory working on right now, across all repos?" hard to answer at a glance.

The goal: a single, opinionated planning model that (a) unifies all work under one concept — the **sprint** — (b) gives a crisp **cross-repo portfolio view** showing only what's currently relevant, and (c) structurally encodes the project's operating principle — *design is collaborative, execution is autonomous* — by making a sprint the handoff artifact between the two.

## The model in one breath

**Everything is a sprint** (the unit formerly called an *epic*) — a named folder with an ordered plan and its task specs. There are no loose/general tasks. Each repo has **exactly one active sprint** at a time. A sprint's scope is **immutable once started** — no tasks are added mid-flight. A task is done when the **reviewer accepts it** (or the architect resolves a repeat rejection); the developer works the task until then. Work discovered *during* a sprint that's out of scope is captured as a **finding** (not a task), which the architect triages into the **backlog** at sprint close; the backlog is the pool from which future sprints — including named *maintenance* sprints — are scoped. The cross-repo **portfolio view** shows, per repo, the active sprint's current + upcoming tasks — nothing else.

## Non-goals

- **Multiple active sprints per repo, or parallel sprints.** Exactly one active sprint per repo is the whole point. (Parallelism *within* a sprint's tasks is a separate question — see [RFC 001](RFC_001_PARALLEL_TASK_EXECUTION.md).)
- **The factory doing sprint planning.** Planning is collaborative human work that *produces* a ready sprint. The factory only *consumes* one. This RFC deliberately *removes* the factory's current "assess/graduate a backlog item" behavior.
- **Governing every change to a repo.** The sprint governs *the factory's queue*, not every possible commit. Urgent human hotfixes (e.g. the 2026-07-22 dependency-audit fix landed directly on `main`) live outside the sprint model — see [Escape hatch](#escape-hatch).
- **A distributed/portfolio-wide single sprint.** "One active sprint" is *per repo*; the portfolio is each repo's active sprint side by side.

## Proposal

### 1. Everything is a sprint (unify the model)

Collapse "epic tasks" and "standalone/general tasks" into one concept: a **sprint** — a named folder `dab/sprints/<name>/` with an ordered plan (`WORK_PLAN.md`), an `overview.md`, and its task specs (`todos/`). Maintenance work is not a special perpetual bucket; it's a **named, finite maintenance sprint** (`maintenance-2026-q3`, etc.) you scope when there's enough of it to warrant one.

This erases the standalone-task special case: there is one code path — *"work the active sprint's next task."* `dab next` no longer needs a backlog branch; the known "`dab next` ignores `dab/todos/`" gap disappears by construction.

### 2. Exactly one active sprint per repo (a `dab` invariant)

Make "at most one active sprint per repo" a **board invariant enforced by `dab check`**. Because `dab check` already runs as the repo's **pre-commit hook**, a board that activates a second sprint is *rejected at commit time* — the invariant enforces itself. The active sprint is the source of truth for "what the factory should work on"; the factory *observes* it rather than deciding it in config (consistent with [ADR 002](../architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md) — derive state from reality).

Switching sprints is an explicit `dab` operation (`dab sprint <name>` to activate; `dab sprint close <name>` when done). That explicit step *is* the "decide the correct sprint" moment when (re)starting the factory.

### 3. Immutable scope + the findings mechanism

**No new tasks are added to a sprint once it has started.** This is what guarantees a sprint always closes (no moving goalposts). Completion is governed entirely by the review gate: **a task is done when the reviewer accepts it** — or, on a repeat rejection, when the architect resolves it — and the developer works the task until then. The reviewer is the sole arbiter of "is this task complete," judged against its spec; there is no separate rule policing what the developer must fix, because anything a task leaves unaddressed is, by construction, either rejected by the reviewer (so it gets fixed) or genuinely out of scope.

Work discovered *during* a sprint that is out of scope for the current tasks — bugs, weaknesses, security issues, refactors, improvements, anything that could become a future task — is captured as a **finding**, not folded into the plan. Two rules keep findings safe:

**Rule 1 — Urgent findings ring the bell immediately.** Since triage happens at sprint *close*, a finding otherwise sits silently until then — unacceptable for a critical security issue. Each finding carries a `severity`; a high-severity one fires an immediate `notify()` (decoupled from close-time triage) so a human can decide: hotfix directly (escape hatch) or abort/re-plan the sprint.

**Rule 2 — Structured and conflict-safe.**
- **One file per finding** in `dab/sprints/<name>/findings/`, *not* a single `FINDINGS.md` — a shared append-file is a merge-conflict hotspot the moment two tasks touch it, and a hard blocker under future parallelism ([RFC 001](RFC_001_PARALLEL_TASK_EXECUTION.md)). Same rationale as `dab`'s one-file-per-task.
- **Light schema per finding**: `id`, `title`, `category` (bug / security / tech-debt / improvement), `severity`, `source` (task + `file:line`), `discovered-by` (role), `description`. Makes the architect's triage a fast, near-mechanical pass — "file to backlog" becomes almost a move.
- Findings **ride in the same PR** as the task that surfaced them (append-as-you-go, reviewed, lands atomically — consistent with completion-in-PR, [ADR 008](../architecture/adr/ADR_008_READ_ONLY_CHECKOUT_COMPLETION_IN_PR.md)).

The bar for "is this a finding?": *would it plausibly become a future task?* Not "here's a stray thought." The architect's triage prunes noise.

### 4. The lifecycle loop

Findings are not a dead-letter box — they are the *source* of future sprints, which closes the loop the "maintenance sprint" idea opened:

```mermaid
flowchart LR
    P["planning<br/>(collaborative, human)"] -->|produces a ready sprint| S["active sprint<br/>(immutable scope)"]
    S -->|factory executes tasks in order| S
    S -->|discovers out-of-scope work| F["findings/<br/>(per-sprint)"]
    F -->|architect triages at close| B["backlog<br/>(staging pool)"]
    B -->|scoped into| P
    S -->|all tasks accepted + triaged| C["sprint closed"]
```

A future **maintenance sprint** is assembled from accumulated backlog findings — it isn't conjured from nowhere.

### 5. The planning / execution boundary (the sprint is the handoff artifact)

- **Planning** (human + assistant, collaborative): scope a sprint from the backlog — a named folder with an ordered, immutable plan. Output: a *ready* sprint.
- **Execution** (factory, autonomous): consume a ready sprint; implement / test / review / merge each task in order.

Consequence: the factory **sheds its backlog-assessment role.** The architect no longer graduates backlog items into sprints (that's planning). The architect's *execution-time* duties remain: mediate a repeat rejection, **triage findings + propose sprint closure**. This is a real simplification and a crisper boundary — and it's the existing operating principle (*design collaborative, execution autonomous*) made structural.

### 6. The cross-repo portfolio view

A **derived, read-only projection** built by the factory (which already reads every managed board each tick — [ADR 002](../architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md)). It is **not** a second writer and does **not** move the source of truth out of the project repos. It extends the local control UI ([RFC 002](RFC_002_FACTORY_CONTROL_UI.md) / `server.mjs`).

Per repo, one card showing **only the active sprint** — current task + ordered upcoming, a progress count, nothing else (no other sprints, no backlog, no done-task detail):

```
┌ leanmacrofeed ──────────────────────────────┐   ┌ some-other-repo ─────────────────────┐
│ Sprint: indicator-source-registry   4/10 ✓  │   │ Sprint: maintenance-2026-q3    1/6 ✓ │
│ ▶ now:   revive_event_outcome_recorded_topic │   │ ▶ now:   bump-deps-and-audit         │
│   next:  migrate_event_ledger_…              │   │   next:  drop-dead-feature-flags     │
│          consolidate_delta_and_tier_logic    │   │          tighten-ci-timeouts         │
│          fix_fred_series_id_drift            │   │          …                           │
│          … parks at remove_legacy_…          │   └──────────────────────────────────────┘
└──────────────────────────────────────────────┘
```

"Only what's currently relevant" = the active sprint's now + next, per repo.

### 7. What this simplifies

- **`dab`:** one uniform `next` path (active sprint's next task); the standalone-todo gap is gone; `dab check` gains the single-active-sprint invariant; the whole `epic` vocabulary collapses to `sprint`.
- **`orchestrator.mjs` `decide()`:** the `next.source === 'backlog'` dispatch branch and the general/standalone special-cases disappear; `findClosableEpic` becomes `findClosableSprint` — "active sprint has no open tasks → propose close (after findings triage)."
- **Roles:** the architect loses backlog-graduation; gains findings-triage-at-close. The completion contract is simply "developer works the task until the reviewer accepts it (or the architect resolves a repeat rejection)."

## Escape hatch

Not everything is a sprint. Genuine **hotfixes** — urgent, out-of-band changes a human makes directly (the 2026-07-22 audit fix on `main` is the canonical example) — live *outside* the factory's sprint queue. The sprint governs what the *factory* consumes, not every change to the repo. High-severity findings (Rule 1) are the trigger that surfaces "this may need a hotfix" to a human.

## Alternatives considered

- **Keep the epic/standalone split, just add a portfolio view.** Rejected: the split is the source of the `dab next` gap and the "what's active?" ambiguity; unifying under sprints is what makes the view (and `decide()`) simple.
- **A perpetual "general" sprint** (an earlier draft of this design). Rejected: a bucket that never closes needs special-case ordering/close semantics and re-introduces "mixing." Named, finite maintenance sprints are cleaner.
- **Mutable sprint scope** (append discovered tasks to the active sprint). Rejected: sprints then never close (moving goalposts). The findings mechanism captures discoveries without touching scope.
- **A "finding vs fix-now" rule** policing whether a discovery belongs to the current task. Rejected as redundant: the review gate already *is* the completeness authority — the reviewer won't accept a task that leaves an in-scope defect, so there's nothing to police separately. Deferring to the reviewer/spec is cleaner than a competing rule.
- **Keep `epic` internally, say "sprint" only in the view.** Rejected: a half-rename leaves two words for one thing. The rename is total.
- **Active-sprint marker in the factory config** instead of a `dab` invariant. Tempting (matches `stopAfterTask`), but it makes the factory the authority on "what's active" rather than the board — against [ADR 002](../architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md). Left as an open fork below, leaning `dab`-invariant.
- **Move the board (and its history) into the factory** (the question that started this design). Rejected: it breaks [ADR 008](../architecture/adr/ADR_008_READ_ONLY_CHECKOUT_COMPLETION_IN_PR.md) atomic completion-in-PR and the [ADR 002](../architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md) controller/reality separation, and couples a multi-repo factory to every project's board. The portfolio view (a read-model) delivers the cross-repo visibility that motivated the question *without* relocating the source of truth.

## Risks & open questions

**Risks**
- **Findings noise.** Agents over-reporting trivia. Mitigated by the "could become a task?" bar + the architect's triage pruning, but worth watching.
- **Urgent-finding latency.** Rule 1's `notify()` must actually reach a human; a missed notification means a critical issue waits until close.
- **Immutability rigidity.** If a sprint's premise proves wrong mid-flight, you can't patch the plan — you abort/re-plan (a whole-sprint, human decision). That's intended, but it's a real cost to name.
- **Board write-contention under parallelism.** The active plan + findings are shared files; one-file-per-finding mitigates findings, but concurrent `WORK_PLAN` box-checks still contend (ties into [RFC 001](RFC_001_PARALLEL_TASK_EXECUTION.md)).
- **Rename blast radius.** `epic` is threaded through `dab` (CLI, `dab/epics/`, frontmatter, `activeEpics`), the factory (`findClosableEpic`, `epic-close-*` ids, prompts, status rendering), the personas, and existing boards (LeanMacroFeed's `dab/epics/indicator-source-registry/`). The migration is mechanical but wide — do it as one atomic pass per surface, not piecemeal, to avoid a half-renamed board that `dab check` can't parse.

**Open forks (decide before building)**
1. **Active-sprint marker:** `dab` invariant (leaning this) vs factory-config field.
2. **Backlog:** confirmed to remain as the pre-sprint staging pool (not shown in the portfolio) — the capture surface for future ideas + triaged findings.
3. **Findings capture mechanism:** a `dab finding add` command (structured, low-friction) vs raw markdown files agents author directly.
4. **Per-repo active sprint** (assumed) — the portfolio is each repo's active sprint, not one global sprint.

## Rollout

Phased across the two codebases; each phase is independently useful.

0. **The rename (`epic` → `sprint`), as one deliberate migration.** `dab`: `dab/epics/` → `dab/sprints/`, `dab epic …` → `dab sprint …`, frontmatter `epic:` → `sprint:`, `activeEpics` → `activeSprints`. Existing boards: move folders + rewrite frontmatter (LeanMacroFeed's live sprint). Factory: `findClosableEpic` → `findClosableSprint`, `epic-close-*` task ids, prompts, status labels. Personas: architect/developer/reviewer wording. Land it atomically per surface so no board is left half-renamed (which would break the pre-commit `dab check`).
1. **`dab` (the model):** single-active-sprint invariant + `dab check` rule; `findings/` dir + schema + `dab finding add`. This fixes the standalone-todo gap and makes the board self-enforcing.
2. **Factory (execution):** simplify `decide()` (drop backlog-assessment, collapse general/standalone paths); add the architect's findings-triage-at-close step; wire high-severity findings to `notify()`.
3. **Portfolio view (visibility):** a factory-side read-model aggregating each repo's active sprint, surfaced in the local UI ([RFC 002](RFC_002_FACTORY_CONTROL_UI.md) / `server.mjs`) — read-only, derived, never a writer.

Same "earn the gate" posture as the rest of the factory: land the rename + `dab` invariant + findings capture first (low-risk, immediately useful), then the execution simplifications, then the view.
