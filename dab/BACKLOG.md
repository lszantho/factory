# Factory: Master Backlog Index

Unscheduled defects, features, and design RFCs for the factory itself — the orchestrator, the agent role prompts, and the control UI.

**This board exists because the factory had none until 2026-08-16**, and its defects were therefore recorded as prose inside the sprint archives of whichever repo happened to surface them. That is not merely untidy: the `blocked-operator`-versus-prose lesson was written down in a consuming repo's sign-off spec on 2026-08-06, correctly and specifically, and was invisible enough that the same defect dispatched an agent at a production wipe-and-rebuild four times on 2026-08-12. A defect recorded where no board can index it is written down and still lost.

---

## 1. Design RFCs

Full index, with companion plans and per-RFC status: [rfcs/README.md](backlog/rfcs/README.md). The checkbox here tracks only whether the proposal has been **scheduled or delivered**, not whether it is written.

- [ ] **RFC 001 — Parallel task execution** — the keystone (WIP cap + in-flight dedup) shipped at `maxConcurrentTasks: 1`; actually running independent tasks concurrently is unscheduled.
  - _Spec:_ [rfc_001_parallel_task_execution.md](backlog/rfcs/rfc_001_parallel_task_execution.md)
- [x] **RFC 002 — Factory control UI** — delivered, and grown past the original MVP scope.
  - _Spec:_ [rfc_002_factory_control_ui.md](backlog/rfcs/rfc_002_factory_control_ui.md)
- [ ] **RFC 003 — Tick cadence** — Phase 1 shipped (fail-fast, log dedup, heartbeat, the factory's first tests); Phase 1.4 and the event-driven Stop-hook remain deferred behind Phase 0's measurement.
  - _Spec:_ [rfc_003_event_driven_ticks.md](backlog/rfcs/rfc_003_event_driven_ticks.md) · _Plan:_ [rfc_003_implementation_plan.md](backlog/rfcs/plans/rfc_003_implementation_plan.md)
- [ ] **RFC 004 — Multi-backend agents** — a sketch, not a settled design. Blocked on naming a real quota incident; see its own Alternatives section for why doing nothing is the null hypothesis.
  - _Spec:_ [rfc_004_multi_backend_agents.md](backlog/rfcs/rfc_004_multi_backend_agents.md)
- [x] **RFC 005 — Sprint-oriented planning** — delivered 2026-07-25, all four rollout steps.
  - _Spec:_ [rfc_005_sprint_oriented_planning.md](backlog/rfcs/rfc_005_sprint_oriented_planning.md) · _Plan:_ [rfc_005_migration_plan.md](backlog/rfcs/plans/rfc_005_migration_plan.md)
- [ ] **RFC 006 — The three places the orchestrator still trusts memory over reality** — three incidents in one evening, all the defect [ADR 002](../docs/architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md) already names. Proposes four changes, none new architecture.
  - _Spec:_ [rfc_006_complete_observation_gaps.md](backlog/rfcs/rfc_006_complete_observation_gaps.md)

---

## 2. Unscheduled Standalone Tasks

- [ ] **Let agents mark a task blocked-operator instead of guessing**
  - _Spec:_ [let_agents_mark_a_task_blocked_operator.md](backlog/let_agents_mark_a_task_blocked_operator.md)
