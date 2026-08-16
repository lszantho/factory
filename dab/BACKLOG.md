# Factory: Master Backlog Index

Unscheduled defects, features, and design RFCs for the factory itself — the orchestrator, the agent role prompts, and the control UI.

**This board exists because the factory had none until 2026-08-16**, and its defects were therefore recorded as prose inside the sprint archives of whichever repo happened to surface them. That is not merely untidy: the `blocked-operator`-versus-prose lesson was written down in a consuming repo's sign-off spec on 2026-08-06, correctly and specifically, and was invisible enough that the same defect dispatched an agent at a production wipe-and-rebuild four times on 2026-08-12. A defect recorded where no board can index it is written down and still lost.

---

## 1. Design RFCs

Full documents live in [docs/rfcs/](../docs/rfcs/README.md); this index tracks whether anything is scheduled off them.

- [ ] **RFC 006 — The three places the orchestrator still trusts memory over reality** — three incidents in one evening, all the defect [ADR 002](../docs/architecture/adr/ADR_002_RECONCILE_STATE_FROM_REALITY.md) already names. Proposes four changes, none new architecture.
  - _Spec:_ [RFC_006_COMPLETE_OBSERVATION_GAPS.md](../docs/rfcs/RFC_006_COMPLETE_OBSERVATION_GAPS.md)

---

## 2. Unscheduled Standalone Tasks

- [ ] **Let agents mark a task blocked-operator instead of guessing**
  - _Spec:_ [let_agents_mark_a_task_blocked_operator.md](backlog/let_agents_mark_a_task_blocked_operator.md)
