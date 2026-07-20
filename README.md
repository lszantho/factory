# factory

An autonomous, multi-agent software-development pipeline. The factory takes a unit of work from a target repo's backlog and drives it to a merged PR through three AI roles — an **architect** (design / RFC / epic work), a **developer** (implements, tests, opens PRs), and a **reviewer** (the merge gate) — coordinated by a deterministic **orchestrator** that decides who does what next.

It is built directly on Claude Code's background-agent (`--bg`) and worktree primitives — no external orchestration framework — and is configured per target repo, so the same tool drives any repo that keeps its work in [`dab` (docs-as-board)](https://github.com/lszantho/docs-as-board) format.

## The one idea to understand first

**The orchestrator has no memory of its own and never polls.** Every run of `node orchestrator.mjs <repo>` is a fresh, one-shot process: it observes the world (the target repo's `dab` board, GitHub PR state, and any running agent sessions), makes exactly **one** decision, acts on it, and exits. Nothing advances between runs.

There is no long-lived "process" object tracking a piece of work through its phases. The lifecycle is *reconstructed from reality* on every tick. This is a deliberate design choice — it's what makes the system crash-safe and self-healing — and it's the thing most worth internalising before reading the code. See [docs/architecture/PRINCIPLES.md](docs/architecture/PRINCIPLES.md).

The orchestrator itself makes **no LLM call**. It's a plain deterministic router. All intelligence lives in the agent sessions it dispatches.

## Quick start

```bash
# One tick against a configured target repo (may act — dispatch/merge/reconcile):
node orchestrator.mjs leanmacrofeed

# Read-only: observe reality and report what a tick WOULD do, without doing it:
node orchestrator.mjs leanmacrofeed --status
node orchestrator.mjs leanmacrofeed --watch      # auto-refreshing status, every 30s
```

A **tick** (no flag) prints a single JSON decision line (also appended to `logs/<repo>.jsonl`): `dispatch`, `wait`, `would-merge`, `merged`, `reconciled-merged`, `blocked`, or `idle`.

`--status` is the answer to *"do I need to run it right now?"* It observes the same reality a tick would — every tracked task's session/PR/CI/review state — and tells you plainly whether a tick would **act** (`▶`), **wait** (`⏸`), or is **blocked** (`⚠`), without touching anything. Run a tick whenever `--status` shows `▶`. The [state-machine doc](docs/architecture/STATE_MACHINE.md) has a fuller "when do I run it?" cheat sheet.

## Layout

| Path | What it is |
| --- | --- |
| `orchestrator.mjs` | The whole decision engine — one tick per invocation. Deterministic, no LLM call. |
| `budget-guard.mjs` | Rolling-window cap on dispatches, so a runaway loop can't spend without bound. |
| `configs/<repo>.json` | Per-target-repo config: paths, thresholds, `autoMerge`, budget, reviewer token path. |
| `state/<repo>.json` | The orchestrator's *only* cross-tick memory: which task → which branch/role. Gitignored. |
| `logs/<repo>.jsonl` | Append-only audit trail of every decision. Gitignored. |
| `docs/` | Architecture, the state machine, the design principles, and ADRs (below). |

The **agent personas** (`architect.md` / `developer.md` / `reviewer.md`) and the rules a factory-dispatched session runs under (`AGENTS.md` §6, "Autonomous Factory Mode") live **in the target repo**, not here — the tool is generic, the behaviour is per-repo. See [ADR 003](docs/architecture/adr/ADR_003_STANDALONE_TOOL_PER_REPO_CONFIG.md).

## Documentation

- **[docs/architecture/PRINCIPLES.md](docs/architecture/PRINCIPLES.md)** — the design philosophy. Why the "process" is deliberately implicit, and why deriving state from reality (rather than storing it) is what makes the system resilient. Start here.
- **[docs/architecture/STATE_MACHINE.md](docs/architecture/STATE_MACHINE.md)** — the tick priority order and the per-task lifecycle, as diagrams, plus a "when do I run it?" cheat sheet.
- **[docs/architecture/adr/](docs/architecture/adr/README.md)** — Architecture Decision Records: the specific, load-bearing decisions and the reasoning behind them.

## Operational status

Currently run **manually**, one tick at a time. As of 2026-07-20 `autoMerge: true` — after the first epic (`linter-modernization`) completed cleanly end-to-end, the human merge gate was retired: the orchestrator now merges an approved, green PR itself (squash + delete branch) and reconciles. The dispatch budget and the manual-tick cadence remain as the still-standing safety gates; a scheduled (cron/launchd) trigger is the next step still deferred. See [ADR 006](docs/architecture/adr/ADR_006_HUMAN_MERGE_GATE_AND_BUDGET.md).
