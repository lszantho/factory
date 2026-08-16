# RFCs

Design proposals for factory changes that are big enough to think through before building. An RFC is a *proposal* (it may be partially implemented, deferred, or superseded); a settled decision graduates into an [ADR](../architecture/adr/README.md).

| # | Title | Status |
| --- | --- | --- |
| [001](RFC_001_PARALLEL_TASK_EXECUTION.md) | Parallel task execution | Proposed — keystone landed, rest future work |
| [002](RFC_002_FACTORY_CONTROL_UI.md) | Factory control UI | Implemented — local dashboard, grown past the original MVP scope |
| [003](RFC_003_EVENT_DRIVEN_TICKS.md) | Tick cadence — is faster polling good enough? | Proposed — Phase 1 (fail-fast, log dedup, first tests) shipped; event-driven Stop-hook deferred |
| [004](RFC_004_MULTI_BACKEND_AGENTS.md) | Multi-backend agents | Proposed — early sketch, not a settled design; abstract the agent CLI so the factory can run Claude or Gemini, with quota-aware fallback |
| [005](RFC_005_SPRINT_ORIENTED_PLANNING.md) | Sprint-oriented planning | Implemented — all rollout steps (0-3) landed: rename, dab invariant, decide() simplification, portfolio view progress fix |
| [006](RFC_006_COMPLETE_OBSERVATION_GAPS.md) | The three places the orchestrator still trusts memory over reality | Proposed — not started. Three incidents in one evening, all the defect ADR 002 already names: the WIP check reads `state.json` as authority and never consults the board (deadlocked the factory, 4 phantom dispatches); an abandoned remote branch is inherited by the next dispatch (produced a `CONFLICTING` PR that could never run CI); and `quietRepeatCount` is counted but never consumed, so impossible conditions are retried indefinitely |
