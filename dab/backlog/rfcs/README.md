# RFCs

Design proposals for factory changes that are big enough to think through before building. An RFC is a *proposal* (it may be partially implemented, deferred, or superseded); a settled decision graduates into an [ADR](../../../docs/architecture/adr/README.md), and scheduled work graduates into a sprint under `dab/sprints/`.

These lived in `docs/rfcs/` until 2026-08-16 and moved here when the factory's board gained a place for them. The move is what put them under `dab check`, which only validates RFCs inside `<boardDir>/backlog/rfcs/` — the required headings (`Context & Motivation`, `Proposed Architecture & Design`, `Alternatives Considered`, `Risks & Open Questions`, per [dab.config.json](../../../dab.config.json)) had never been applied to any of them.

Companion build and cutover plans live in [plans/](plans/) — they are execution detail for an RFC above, not proposals in their own right, and they carry none of the four required sections.

| # | Title | Status |
| --- | --- | --- |
| [001](rfc_001_parallel_task_execution.md) | Parallel task execution | Proposed — keystone landed, rest future work |
| [002](rfc_002_factory_control_ui.md) | Factory control UI | Implemented — local dashboard, grown past the original MVP scope |
| [003](rfc_003_event_driven_ticks.md) | Tick cadence — is faster polling good enough? | Proposed — Phase 1 (fail-fast, log dedup, first tests) shipped; event-driven Stop-hook deferred |
| [004](rfc_004_multi_backend_agents.md) | Multi-backend agents | Proposed — early sketch, not a settled design; abstract the agent CLI so the factory can run Claude or Gemini, with quota-aware fallback |
| [005](rfc_005_sprint_oriented_planning.md) | Sprint-oriented planning | Implemented — all rollout steps (0-3) landed: rename, dab invariant, decide() simplification, portfolio view progress fix |
| [006](rfc_006_complete_observation_gaps.md) | The three places the orchestrator still trusts memory over reality | Proposed — not started. Three incidents in one evening, all the defect ADR 002 already names: the WIP check reads `state.json` as authority and never consults the board (deadlocked the factory, 4 phantom dispatches); an abandoned remote branch is inherited by the next dispatch (produced a `CONFLICTING` PR that could never run CI); and `quietRepeatCount` is counted but never consumed, so impossible conditions are retried indefinitely |

## Companion plans

Execution detail for an RFC above. Not proposals, and deliberately outside the heading rules `dab check` applies to this directory.

| Plan | For | Status |
| --- | --- | --- |
| [rfc_003_implementation_plan.md](plans/rfc_003_implementation_plan.md) | [RFC 003](rfc_003_event_driven_ticks.md) | Phases 0–1 shipped; Phase 2 gated on Phase 0's measurement |
| [rfc_005_migration_plan.md](plans/rfc_005_migration_plan.md) | [RFC 005](rfc_005_sprint_oriented_planning.md) | Executed 2026-07-25 — historical record of the `epic` → `sprint` cutover |
