# Developer Agent Guidelines: DaB (Docs-as-Board) System

This document defines the rules, conventions, and ways of working for developers and AI coding agents operating within this repository using the **DaB (Docs-as-Board)** system.

---

## 1. TODO & Task Management Rules (DaB)

All planning, roadmapping, and development tasks are managed directly in the repository under the `dab/` directory.

### The Master Indexes (`dab/TODO.md` & `dab/BACKLOG.md`)
*   `dab/TODO.md` is the single source of truth for the active milestone/sprint. It links *only* to active standalone tasks in `dab/todos/` or active sprint work plans in `dab/sprints/`.
*   `dab/BACKLOG.md` is the single source of truth for unscheduled ideas, features, tech debt, and design RFC drafts.
*   Indexes must remain clean, containing only high-level categorizations and checklists.
*   **Every checklist item must link directly to its corresponding spec file** under `dab/todos/`, `dab/backlog/`, or `dab/sprints/`.

### Dedicated Task Specs
*   Every task must have its own `.md` file describing its objectives, requirements, and execution tasks.
*   Filename convention: Lowercase with underscores, describing the task (e.g., `vertex_ai_integration.md`).
*   Specs must be located in:
    *   `dab/todos/` for active standalone tasks.
    *   `dab/backlog/` for unscheduled standalone tasks.
    *   `dab/sprints/[sprint-name]/todos/` for tasks belonging to a specific active sprint.

### Spec Templates
Standardized Markdown templates live in `dab/templates/` and must be used when creating new documents:
*   `TASK_TEMPLATE.md`: For standalone/sprint developer tasks.
*   `RFC_TEMPLATE.md`: For collaborative architectural proposals.
*   `SPRINT_OVERVIEW_TEMPLATE.md`: For sprint boundaries and design specifications.
*   `SPRINT_WORK_PLAN_TEMPLATE.md`: For sprint milestones and sub-task checklists.
*   `SPRINT_HANDOFF_TEMPLATE.md`: For session-to-session notes during multi-day sprints.

---

## 2. Way of Working & Task Lifecycle

To move a task from conception to completion, follow this lifecycle:

```
[ BACKLOG ] ───► [ ACTIVE SPRINT ] ───► [ ARCHIVED ]
(dab/backlog/)       (dab/todos/)       (dab/archive/)
```

### 1. In the Backlog (Unscheduled)
*   Ideas start as list items in `dab/BACKLOG.md`.
*   If the idea is complex or changes system architecture, create an **RFC** in `dab/backlog/rfcs/rfc_[name].md` to align on technical designs first.

### 2. Graduating to Active Sprint
*   **For Standalone Tasks**: Move the spec file from `dab/backlog/` to `dab/todos/` and list it under the active section of `dab/TODO.md`.
*   **For Sprints**: When an RFC is approved, graduate it into a sprint:
    1. Create directory `dab/sprints/[sprint-name]/`.
    2. Move the RFC into the folder as `overview.md`.
    3. Create a `WORK_PLAN.md` with task checkboxes.
    4. Create individual task files inside `dab/sprints/[sprint-name]/todos/`.

### 3. Execution (Active Work)
*   Before beginning coding, the agent should create or update `task.md` at the IDE app data directory (a local git-ignored checklist) to track step-by-step progress.
*   Mark active tasks in the spec files as `[/]` (in-progress) and completed tasks as `[x]`.

### 4. Verification & Validation
*   Run the project's local formatting, linting, and build verification suite (e.g., `pnpm run validate` or `npm run test`) before pushing.

### 5. Archiving (Completed Work)
*   Once the Pull Request is merged into `main`:
    *   Move standalone task specs to `dab/archive/tasks/`.
    *   Move entire completed sprint folders to `dab/archive/sprints/`.
    *   Update `dab/TODO.md`'s archived list by appending the completed item with its completion date: `(YYYY-MM-DD)`.

---

## 3. Explicit Approval Before Any Action

The agent must never act speculatively or make changes while explaining. All actions require a clear stop-and-confirm cycle.

1.  **Present intent first, act second:**
    *   Before making ANY file edits, running terminal commands, installing packages, committing, or pushing, the agent MUST present a clear summary of what it intends to do.
    *   **STOP and wait** for explicit user approval (`"yes"`, `"proceed"`, etc.) before executing.
2.  **No speculative fixes:**
    *   Do not fix, refactor, or "improve" anything that was not explicitly requested, even if a problem is noticed along the way. Report noticed issues to the user instead.
3.  **One thing at a time:**
    *   Do not chain multiple independent changes into a single action. Each logical unit of work requires its own approval cycle.

