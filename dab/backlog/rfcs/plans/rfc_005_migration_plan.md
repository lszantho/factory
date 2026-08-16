# RFC 005 — Step 0 migration plan (`epic` → `sprint`)

**Status: EXECUTED (2026-07-25).** The precondition held right after `acquisition-reliability` closed, and the cutover ran as planned: `docs-as-board-node` (the dab tool) landed first, then LeanMacroFeed's board + personas, then the factory's `orchestrator.mjs` + docs, in that order, each verified before the next. This is the concrete cutover plan for [RFC 005](../rfc_005_sprint_oriented_planning.md) Rollout step 0 — the total rename of `epic` → `sprint`. It was deliberately a **hard cutover on a quiescent board**, not a live mid-sprint change (see the RFC's "Rename blast radius" risk and the survey below for why it would otherwise have been dangerous).

## Why parked

The rename spans a **shared tool** and **live board content that is currently an in-flight sprint**. Doing it mid-sprint would conflict with any open PR, desync `state.json`, and — because `dab check` runs as a pre-commit hook — a moment of tool↔board inconsistency **blocks every commit in the repo**. The safe seam is *between* sprints: let `indicator-source-registry` (the last epic-era sprint) close, then cut over on a clean board before the next sprint starts.

## Precondition (clean slate)

All must be true before starting:
- [ ] `indicator-source-registry` fully merged and **closed** (`dab epic close`), no unchecked tasks.
- [ ] No open factory-managed PRs; no leftover worktrees under `.claude/worktrees/`.
- [ ] Factory **stopped** (`launchctl unload -w …plist`) and `state/leanmacrofeed.json` has an empty `tasks` object.
- [ ] `main` clean and pushed on every affected repo (LeanMacroFeed, factory, docs-as-board).
- [ ] A note on **where closed sprints live** confirmed (archive dir vs in-place `status: done`) — the migration must move *all* board content, not just the active dir.

## Blast radius (from the 2026-07-22 survey)

| Surface | Repo | Scope |
| --- | --- | --- |
| **dab tool** | `docs-as-board-node` | **177 refs / 22 files.** `epic` is first-class: `commands/epic.ts` (+ test) → a `dab epic` subcommand; `utils/epics.ts` (+ test); frontmatter field; `activeEpics` in `dab status` JSON; threaded through `next`/`status`/`check`/`init`/`new`/`list`/`takeover`/`complete`. A real TS refactor + rebuild + `vitest` run — not a sed. |
| **Board content** | LeanMacroFeed | `dab/epics/` → `dab/sprints/` (dir move); `epic:` → `sprint:` in **16 task files**; `overview.md`/`WORK_PLAN.md` wording; backlog/templates; archived sprints. |
| **Board content** | docs-as-board | Its own `dab/` board is **empty** of epics today — just the dir convention + templates, but its own pre-commit `dab check` must still pass against the rebuilt tool. |
| **Personas** | LeanMacroFeed | `.claude/agents/architect.md`, `developer.md` — wording + `dab epic close` / `dab new task --epic`. |
| **Orchestrator** | factory | **10 refs in `orchestrator.mjs`**: `findClosableEpic` → `findClosableSprint`; `epic-close-<id>` task ids → `sprint-close-<id>`; `statusPayload.activeEpics` → `activeSprints`; `t.epic` → `t.sprint`; `next.source === 'epic'`; the epic-closing prompt + `--status` labels. |
| **Docs/ADRs** | factory | ~10 refs. **Judgment call** — see decisions below. |

## Ordered cutover

The hard constraint: **the rebuilt tool and the migrated board must land together**, because `dab check` (pre-commit hook) fails on any tool↔board mismatch. So build + verify everything in working trees first, commit last.

### 1. dab tool (`docs-as-board-node`) — on a branch
1. Rename the concept in `src/` everywhere: the `epic` command → `sprint` (`commands/epic.ts` → `commands/sprint.ts`, help text, arg parsing), `utils/epics.ts` → `utils/sprints.ts`, the frontmatter field `epic` → `sprint`, the `dab/epics/` dir convention → `dab/sprints/`, the `activeEpics` status-JSON key → `activeSprints`, and all types/identifiers.
2. Update the tests (`*.test.ts`) to match; keep `vitest` green.
3. **Decide backward-compat:** since this is a hard cutover on a clean slate, no dual-read is required — but a one-release *read-both* shim (accept `epic:` OR `sprint:`) would de-risk any stragglers. Recommended: **hard rename, no shim** (clean slate makes it safe); note the choice.
4. `pnpm build` → refresh `dist/`. **Do not deploy `dist/` until step 4** (the live factory still calls the old `dist`).

### 2. Board content (LeanMacroFeed) — in a working tree
1. `git mv dab/epics dab/sprints` (and any archive dir).
2. Rewrite frontmatter `^epic:` → `^sprint:` across the 16 task files; update `t.epic` references, `WORK_PLAN.md`/`overview.md` prose, `dab/templates/*` (RFC/task templates), and backlog references.
3. Update `.claude/agents/architect.md` + `developer.md` wording and `dab` command examples.

### 3. Orchestrator + factory
1. `orchestrator.mjs`: the 10 refs above (`findClosableEpic`→`findClosableSprint`, `epic-close-`→`sprint-close-`, `activeEpics`→`activeSprints`, `t.epic`→`t.sprint`, `next.source==='epic'`, prompt + label text).
2. `configs/leanmacrofeed.json`: nothing epic-named today (`stopAfterTask` is a task id) — verify.
3. Factory tests still green (`npm test`).

### 4. Land it together (order matters)
1. **docs-as-board**: commit the renamed tool + rebuilt `dist/` + its own (empty) board dir rename. Its pre-commit `dab check` now runs the new tool against the new convention → passes. *(AI-authorship trailer is allowed in this repo.)*
2. Point LeanMacroFeed at the rebuilt tool if the path changed (it's `paths.dabEntry` in `configs/leanmacrofeed.json` → `…/dist/bin/index.js`; unchanged unless the entry path moves).
3. **LeanMacroFeed**: commit the migrated board + personas. The pre-commit `dab check` now uses the new tool + new board → passes. *(No AI trailer — commit-msg hook rejects it.)*
4. **factory**: commit `orchestrator.mjs` + docs. *(No AI trailer — repo hook rejects it.)*

## Verification (before declaring done)
- `dab check` clean in LeanMacroFeed **and** docs-as-board (proves tool↔board consistency; also the gate the pre-commit hook enforces).
- `dab status` / `dab next` return the expected shape with `sprint`/`activeSprints` keys.
- `node orchestrator.mjs leanmacrofeed --status` runs clean and shows the (empty) board without throwing.
- dab `vitest` + factory `npm test` both green.
- `grep -rniw epic` across all four surfaces returns only intentional historical mentions (see ADR decision).

## Rollback
Each surface is a git-tracked change on a branch; nothing is pushed until all four verify. Rollback = discard the branches / `git reset` before the final commits. The `dist/` rebuild is reproducible from reverted `src`. Because the factory is stopped and the board is quiescent, there's no in-flight state to unwind.

## Decisions to make at execution time
- **ADRs/historical docs:** recommend **leave the historical text as-is** (they record decisions made when the term was "epic") and add a single glossary/redirect note (e.g. in `docs/architecture/adr/README.md`: "'epic' in ADRs 001–00N is now called 'sprint'"), rather than rewriting decision history. The RFC's "total rename" applies to *live* code/board/CLI, not the archaeological record.
- **Backward-compat shim:** hard rename vs one-release read-both. Recommend hard (clean slate). Reconsider only if a third dab consumer appears.
- **Archived-sprint location:** confirm during the precondition; migrate it too.
- **`WORK_PLAN.md` / `todos/` naming:** left as-is (not epic-named). Only rename if a broader restructure is wanted — out of scope here.

## Effort estimate
The dab-tool rename (177 refs, first-class concept, tests) is the long pole — a focused session on its own. Board + factory + personas + verification is a shorter, mostly-mechanical follow-on once the tool is green. Total: plan for one dedicated sitting on a clean board, not a between-things quick task.
