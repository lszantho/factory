# Architecture Decision Records

Index of ADRs for the **factory** — the autonomous multi-agent development pipeline. Each records a specific decision — the problem it solves, the decision made, and its consequences — so the reasoning survives past the session that established it.

These are the concrete decisions; the shared philosophy behind them lives in [../PRINCIPLES.md](../PRINCIPLES.md).

**Terminology note:** ADRs 001–008 predate [RFC 005](../../../dab/backlog/rfcs/rfc_005_sprint_oriented_planning.md)'s total rename and still say "epic" where current code and docs say **sprint**. Left as written — they record decisions made when that was the term; see RFC 005 for the rename itself.

| # | Title | Status | Summary |
| --- | --- | --- | --- |
| [001](ADR_001_DETERMINISTIC_ORCHESTRATOR.md) | A deterministic orchestrator; intelligence only in dispatched agents | Approved | The coordination layer makes no LLM call — it's a pure router. All judgment lives in the architect/developer/reviewer sessions it spawns. Keeps the loop cheap, predictable, and auditable. |
| [002](ADR_002_RECONCILE_STATE_FROM_REALITY.md) | Reconcile state from reality; don't store process state | Approved | Level-triggered, not event-driven. Every tick re-derives "what's next" from the live `dab` board + GitHub, rather than tracking a stored lifecycle. Crash-safe, idempotent, self-healing. The core principle. |
| [003](ADR_003_STANDALONE_TOOL_PER_REPO_CONFIG.md) | Standalone tool, per-repo configuration | Approved | The engine is generic and project-agnostic; agent personas, conventions, and per-repo settings live in the target repo, selected by a config file. One tool, many repos, no engine forks. |
| [004](ADR_004_DISTINCT_REVIEWER_IDENTITY.md) | A distinct GitHub identity for the reviewer, sourced inline | Approved | GitHub blocks self-approval, so the reviewer needs its own account. The token is sourced per-command by the reviewer itself, not injected as dispatch-time env — which doesn't survive the warm-pool. |
| [005](ADR_005_LIVENESS_FROM_TRANSCRIPT_MTIME.md) | Detect a running session by transcript mtime, not PID | Approved | `claude agents --json`'s pid is unreliable in both directions (recycled pids; warm-pool argv). The live session transcript's mtime is silent exactly when the session is silent. |
| [006](ADR_006_HUMAN_MERGE_GATE_AND_BUDGET.md) | A human merge gate and a dispatch budget while the pipeline matures | Approved | `autoMerge` off (humans gate the one irreversible step), a rolling dispatch cap, and manual ticks as a circuit-breaker. Deliberately relaxable as trust is earned, not permanent. |
| [007](ADR_007_BYPASS_PERMISSIONS_FOR_DISPATCH.md) | `bypassPermissions` for background dispatches | Approved | A `--bg` session can't answer interactive prompts, so `acceptEdits` would deadlock it. The target repo's `AGENTS.md` §6 + `--disallowedTools` are the real safety net, not an interactive gate. |
| [008](ADR_008_READ_ONLY_CHECKOUT_COMPLETION_IN_PR.md) | Orchestrator only reads and fast-forwards the target checkout; completion flows through the PR | Approved | The orchestrator never writes to the local checkout: the developer marks its task done inside its PR (like epic-close already does), and a tick fast-forwards the checkout to origin before observing. Kills local staleness and dirty-tree drift by construction. |

## When to write a new ADR

A decision belongs here if it would be genuinely costly to re-litigate or accidentally reverse without knowing why it was made — a choice between real alternatives with tradeoffs on either side, especially one that was learned the hard way through a concrete failure. Routine implementation details do not need an ADR. If it constrains how the factory will work across future tasks and repos, record it.
