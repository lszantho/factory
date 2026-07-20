# ADR 001: A deterministic orchestrator; intelligence only in dispatched agents

## Status

Approved

## Context

The factory coordinates AI agents to build software. The obvious temptation, given that the work is AI-driven, is to make the coordinator itself an agent too — an "orchestrator agent" that reasons about the state of the project and decides what to do next in natural language.

That would be a mistake for the part of the system that must run frequently, be trusted to act unattended, and be debuggable after the fact:

- **Non-determinism where you least want it.** The coordination layer is exactly the part that must behave the same way every time given the same inputs. An LLM in that seat means the same board state could produce different dispatch decisions run to run, for reasons that are hard to reproduce.
- **Cost and latency on every heartbeat.** This loop is meant to run often (eventually on a timer). A model call per tick is slow and expensive for what is, at bottom, a routing decision.
- **Auditability.** When something goes wrong, "why did it dispatch a developer here?" must have a concrete, code-level answer, not a prompt-and-sampling answer.

## Decision

**The orchestrator makes no LLM call of its own. It is a plain, deterministic router.** Given the observed state, it runs a fixed decision tree ([`decide()`](../../../orchestrator.mjs)) and emits exactly one action. Its own header comment states the rule: *"one tick of the factory: deterministic router, no LLM call of its own."*

All judgment is confined to the **agent sessions it dispatches** — the architect, developer, and reviewer roles, each an ordinary Claude Code `--bg` session with a written persona. The boundary is sharp:

- **Code** decides *who acts next and why* (dispatch a developer for a new task, a reviewer for a green PR, an architect to close an epic).
- **Agents** do *the work that needs reasoning* (write and test the code, design the RFC, judge whether the PR should merge).

## Consequences

- **The coordination layer is trivial to reason about and cheap to run.** A tick is a few `dab`/`gh` reads and a decision tree; it can run on a tight schedule without model cost.
- **Non-determinism is confined to individually-reviewed units of work.** Every agent's output is a PR that passes through the reviewer role, CI, and (for now) a human merge gate. The unpredictable part is always bounded by a review.
- **The decision logic is fully testable and replayable** without invoking a model — the same inputs always yield the same decision, and every decision is logged as a JSON line.
- **A real division of labour to maintain.** New behaviour has to be sorted correctly: is this a routing rule (goes in the orchestrator as code) or a judgment (goes in a role's persona in the target repo)? Blurring the two — e.g. encoding project-specific judgment into the orchestrator — would erode the property that makes this work. See [ADR 003](ADR_003_STANDALONE_TOOL_PER_REPO_CONFIG.md).
