# ADR 003: Standalone tool, per-repo configuration

## Status

Approved

## Context

The factory was built to drive the LeanMacroFeed project, but the mechanism — dispatch roles, route work by board + PR state, gate merges — is not specific to that project. The question was where the project-specific parts should live: baked into the orchestrator alongside the generic logic, or separated out.

Baking project knowledge into the engine would mean a fork (or a tangle of conditionals) per target repo, and would blur the clean line established in [ADR 001](ADR_001_DETERMINISTIC_ORCHESTRATOR.md) between generic routing (code) and project-specific judgment (agents). It also has a natural precedent to follow: the sibling `dab`/`docs-as-board` tool already uses exactly this split — a standalone tool, with the board content living in each project.

## Decision

**The factory is a standalone, project-agnostic tool. Everything project-specific lives in the target repo, selected by a per-repo config file.**

- **The engine** (`orchestrator.mjs`, `budget-guard.mjs`) lives here, in its own repo, and knows nothing about any particular project.
- **Per-repo config** lives here as `configs/<repo>.json`: the target repo's path and GitHub slug, `dryRun`/`autoMerge` flags, the dispatch budget, `staleSessionMinutes`, the reviewer token path, and the absolute paths to `node`/`dab`/`claude`/`gh`.
- **Per-repo runtime state and logs** live here as `state/<repo>.json` and `logs/<repo>.jsonl` (both gitignored).
- **The agent personas and rules live in the target repo**: `.claude/agents/{architect,developer,reviewer}.md` (thin role personas) and `AGENTS.md` §6 "Autonomous Factory Mode" (the rules a factory-dispatched session runs under — which suspend the repo's normal interactive-pairing rules for dispatched sessions only).

## Consequences

- **One engine, many repos.** Onboarding a new target repo is a new `configs/<repo>.json` plus the repo's own `.claude/agents/` personas and `AGENTS.md` section — no change to the orchestrator.
- **Behaviour is owned by the repo it affects.** A project tunes how its architect/developer/reviewer behave by editing files in its own tree, versioned alongside its code, without touching shared tooling.
- **The engine repo has no remote yet.** It currently lives as a local git repo only; this is fine for a single-operator setup but is a known "not yet pushed anywhere" state.
- **Config carries absolute machine paths.** Because the orchestrator shells out to specific `node`/`dab`/`claude`/`gh` binaries, `configs/<repo>.json` is currently machine-specific. Portability across machines would require making those relative or discovered rather than pinned.
- **A subtle coupling to keep honest.** The generic engine still encodes a few assumptions about the target repo's conventions (that it uses `dab`, that branches are `worktree-<taskId>`, that the reviewer submits via `gh`). These are conventions the target repo must uphold; they are documented in the state machine and the personas rather than enforced by the engine.
