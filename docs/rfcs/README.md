# RFCs

Design proposals for factory changes that are big enough to think through before building. An RFC is a *proposal* (it may be partially implemented, deferred, or superseded); a settled decision graduates into an [ADR](../architecture/adr/README.md).

| # | Title | Status |
| --- | --- | --- |
| [001](RFC_001_PARALLEL_TASK_EXECUTION.md) | Parallel task execution | Proposed — keystone landed, rest future work |
| [002](RFC_002_FACTORY_CONTROL_UI.md) | Factory control UI | Proposed — local dashboard to observe/drive the factory |
| [003](RFC_003_EVENT_DRIVEN_TICKS.md) | Tick cadence — is faster polling good enough? | Proposed — study; cost analysis of frequent polling (rate limits, log noise, fail-fast) vs. event-driven triggers |
| [004](RFC_004_MULTI_BACKEND_AGENTS.md) | Multi-backend agents | Proposed — abstract the agent CLI so the factory can run Claude or Gemini, with quota-aware fallback |
| [005](RFC_005_SPRINT_ORIENTED_PLANNING.md) | Sprint-oriented planning | Proposed — one active sprint per repo, immutable scope, findings→backlog loop, cross-repo portfolio view |
